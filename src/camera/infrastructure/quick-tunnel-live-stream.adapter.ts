import { Injectable } from '@nestjs/common';
import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, lstat, readFile, readlink, unlink } from 'node:fs/promises';
import {
  get as httpGet,
  createServer,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Readable } from 'node:stream';
import { createServer as createUnixServer, type Server as NetServer, type Socket } from 'node:net';
import {
  createLiveStreamProcessId,
  type LiveStreamProcessId,
  type LiveStreamSource,
  type LiveStreamViewer,
} from '../domain/live-stream.entity';
import type { LiveStreamGatewayPort } from '../domain/ports/live-stream-gateway.port';
import type { RtspStreamRuntimeHandle, RtspStreamRuntimePort } from '../domain/ports/rtsp-stream-runtime.port';

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const FRAME_BUFFER_LIMIT_BYTES = 2 * 1024 * 1024;
const VIEWER_QUEUE_LIMIT = 2;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
} as const;

export interface CloudflaredChild extends EventEmitter {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface QuickTunnelLiveStreamDependencies {
  spawnCloudflared?: (
    args: string[],
    options: SpawnOptions,
  ) => CloudflaredChild;
  publicProbe?: (input: { hostname: string; path: string }) => Promise<void>;
  identifyProcess?: (pid: number) => Promise<string | null>;
  processGroupId?: (pid: number) => Promise<number | null>;
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => boolean | void;
  workerProcessGroupId?: number;
  startupTimeoutMs?: number;
  stopGraceMs?: number;
  maxViewers?: number;
  rtspRuntime?: RtspStreamRuntimePort;
  rtspSocketDirectory?: string;
  inspectRtspDirectory?: (path: string) => Promise<void>;
  inspectRtspSocket?: (path: string) => Promise<void>;
  chmodRtspSocket?: (path: string, mode: number) => Promise<void>;
  unlinkRtspSocket?: (path: string) => Promise<void>;
  wallNow?: () => number;
  monotonicNow?: () => number;
}

interface ActiveViewer {
  tokenHash: string;
  response: ServerResponse;
  queue: Buffer[];
  draining: boolean;
}

@Injectable()
export class QuickTunnelLiveStreamAdapter implements LiveStreamGatewayPort {
  private readonly spawnCloudflared: NonNullable<QuickTunnelLiveStreamDependencies['spawnCloudflared']>;
  private readonly publicProbe: NonNullable<QuickTunnelLiveStreamDependencies['publicProbe']>;
  private readonly identifyProcess: NonNullable<QuickTunnelLiveStreamDependencies['identifyProcess']>;
  private readonly processGroupId: NonNullable<QuickTunnelLiveStreamDependencies['processGroupId']>;
  private readonly signalProcessGroup: NonNullable<QuickTunnelLiveStreamDependencies['signalProcessGroup']>;
  private readonly workerProcessGroupId: number;
  private readonly startupTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly maxViewers: number;
  private readonly viewers = new Map<string, LiveStreamViewer>();
  private readonly activeViewers = new Set<ActiveViewer>();
  private server?: Server;
  private child?: CloudflaredChild;
  private childIdentity?: string;
  private childGroupValidated = false;
  private source?: LiveStreamSource;
  private upstreamRequest?: ClientRequest;
  private upstreamResponse?: IncomingMessage;
  private upstreamBoundary?: Buffer;
  private upstreamOpened = false;
  private upstreamUnavailable = false;
  private frameBuffer = Buffer.alloc(0);
  private outputMonitor?: CloudflaredOutputMonitor;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly rtspRuntime?: RtspStreamRuntimePort;
  private readonly rtspSocketDirectory: string;
  private readonly inspectRtspDirectory: (path: string) => Promise<void>;
  private readonly inspectRtspSocket: (path: string) => Promise<void>;
  private readonly chmodRtspSocket: (path: string, mode: number) => Promise<void>;
  private readonly unlinkRtspSocket: (path: string) => Promise<void>;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private rtspHandle?: RtspStreamRuntimeHandle;
  private rtspSessionId?: string;
  private rtspStartAttempted = false;
  private producerServer?: NetServer;
  private producerServerClose?: Promise<void>;
  private producerListen?: Promise<void>;
  private producerListenSettled = false;
  private producerSocket?: Socket;
  private producerAccepted = false;
  private producerPath?: string;
  private frameReady?: Promise<void>;
  private resolveFrameReady?: () => void;
  private rejectFrameReady?: (error: Error) => void;
  private rtspReady = false;
  private failureHandler?: () => void;

  constructor(dependencies: QuickTunnelLiveStreamDependencies = {}) {
    this.spawnCloudflared = dependencies.spawnCloudflared ?? defaultSpawn;
    this.publicProbe = dependencies.publicProbe ?? defaultPublicProbe;
    this.identifyProcess = dependencies.identifyProcess ?? linuxProcessIdentity;
    this.processGroupId = dependencies.processGroupId ?? linuxProcessGroupId;
    this.signalProcessGroup = dependencies.signalProcessGroup ?? defaultSignalProcessGroup;
    this.workerProcessGroupId = dependencies.workerProcessGroupId ?? readOwnProcessGroupId();
    this.startupTimeoutMs = dependencies.startupTimeoutMs ?? 30_000;
    this.stopGraceMs = dependencies.stopGraceMs ?? 2_000;
    this.maxViewers = dependencies.maxViewers ?? 2;
    this.rtspRuntime = dependencies.rtspRuntime;
    this.rtspSocketDirectory = dependencies.rtspSocketDirectory ?? '/run/home-worker/live-stream-output';
    this.inspectRtspDirectory = dependencies.inspectRtspDirectory ?? inspectRestrictedOutputDirectory;
    this.inspectRtspSocket = dependencies.inspectRtspSocket ?? inspectGatewayOwnedSocket;
    this.chmodRtspSocket = dependencies.chmodRtspSocket ?? chmod;
    this.unlinkRtspSocket = dependencies.unlinkRtspSocket ?? unlink;
    this.wallNow = dependencies.wallNow ?? Date.now;
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  }

  get localOrigin(): string | null {
    if (!this.server) return null;
    const address = this.server.address();
    return address && typeof address !== 'string'
      ? `http://127.0.0.1:${address.port}`
      : null;
  }

  get activeViewerCount(): number {
    return this.activeViewers.size;
  }

  onFailure(handler: () => void): void {
    this.failureHandler = handler;
  }

  start(input: Parameters<LiveStreamGatewayPort['start']>[0]): ReturnType<LiveStreamGatewayPort['start']> {
    return this.enqueueLifecycle(() => this.startExclusive(input));
  }

  private async startExclusive(input: Parameters<LiveStreamGatewayPort['start']>[0]): ReturnType<LiveStreamGatewayPort['start']> {
    if (this.server || this.child) throw new Error('Live stream gateway is already running');
    let rtspStartedAtUnixMs: number | undefined;
    let rtspDeadlineMonotonicMs: number | undefined;
    this.source = input.source;
    try {
      if (input.source.kind === 'rtsp') {
        if (!this.rtspRuntime) throw new Error('RTSP runtime unavailable');
        const rtspStartedAtMonotonicMs = this.monotonicNow();
        rtspStartedAtUnixMs = this.wallNow();
        rtspDeadlineMonotonicMs = rtspStartedAtMonotonicMs + Math.min(
          this.startupTimeoutMs,
          input.session.durationMs,
        );
        await this.openRtspProducer(input.session.id, rtspDeadlineMonotonicMs);
        this.rtspSessionId = input.session.id;
        this.rtspStartAttempted = true;
        const runtimeStart = this.rtspRuntime.start({
          cameraId: input.source.cameraId,
          sessionId: input.session.id,
          socketPath: this.producerPath!,
          expiresAtUnixMs: rtspStartedAtUnixMs + Math.min(input.session.durationMs, 300_000),
          deadlineMonotonicMs: rtspDeadlineMonotonicMs,
        });
        try {
          this.rtspHandle = await withMonotonicDeadline(
            runtimeStart,
            rtspDeadlineMonotonicMs,
            this.monotonicNow,
            'RTSP runtime startup timed out',
          );
        } catch (error) {
          if (error instanceof MonotonicDeadlineError) {
            await this.fenceLateRuntimeStart(
              runtimeStart,
              input.session.id,
              rtspDeadlineMonotonicMs,
            );
          }
          throw error;
        }
        await withMonotonicDeadline(
          this.frameReady!,
          rtspDeadlineMonotonicMs,
          this.monotonicNow,
          'RTSP frame readiness timed out',
        );
        this.rtspReady = true;
      }
      await this.openLoopbackServer();
      const origin = this.localOrigin;
      if (!origin) throw new Error('Loopback listener did not publish an address');
      const child = this.spawnCloudflared(
        ['tunnel', '--url', origin, '--no-autoupdate'],
        { detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.child = child;
      const monitor = createCloudflaredOutputMonitor(child);
      this.outputMonitor = monitor;
      void monitor.failure.catch(() => undefined);
      if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
        throw new Error('Cloudflared did not publish a valid process identifier');
      }
      const processIdentity = await this.identifyProcess(child.pid);
      if (!processIdentity) throw new Error('Cloudflared process identity is unavailable');
      this.childIdentity = processIdentity;
      if (!(await this.isDetachedProcessGroup(child.pid))) {
        throw new Error('Cloudflared process group is not detached from the worker');
      }
      this.childGroupValidated = true;
      const hostname = await withTimeout(
        Promise.race([monitor.hostname, monitor.failure]),
        this.startupTimeoutMs,
        'Quick Tunnel hostname timed out',
      );
      const readinessToken = randomBytes(32).toString('base64url');
      const readinessHash = hashToken(readinessToken);
      this.viewers.set(readinessHash, {
        tokenHash: readinessHash,
        telegramId: 0,
        expiresMonotonicMs: Number.MAX_SAFE_INTEGER,
      });
      try {
        await withTimeout(
          Promise.race([
            this.publicProbe({ hostname, path: `/watch/${readinessToken}` }),
            monitor.failure,
          ]),
          this.startupTimeoutMs,
          'Quick Tunnel did not become externally ready',
        );
      } finally {
        this.viewers.delete(readinessHash);
      }
      monitor.beginDrain();
      return {
        publicHostname: hostname,
        pid: createLiveStreamProcessId(child.pid),
        processIdentity,
      };
    } catch (error) {
      try {
        await this.cleanupExclusive(rtspDeadlineMonotonicMs);
      } catch {
        await this.retryStartupCleanupUntilComplete();
      }
      throw error;
    }
  }

  async addViewer(viewer: LiveStreamViewer): Promise<void> {
    if (!this.server || !isSha256Hex(viewer.tokenHash)) {
      throw new Error('Live stream gateway is unavailable');
    }
    this.viewers.set(viewer.tokenHash.toLowerCase(), structuredClone(viewer));
  }

  async revokeViewer(tokenHash: string): Promise<void> {
    this.viewers.delete(tokenHash.toLowerCase());
    for (const active of [...this.activeViewers]) {
      if (safeHashEqual(active.tokenHash, tokenHash)) active.response.destroy();
    }
  }

  stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.cleanupExclusive());
  }

  private async cleanupExclusive(deadlineMonotonicMs?: number): Promise<void> {
    let cleanupError: unknown;
    if (this.rtspHandle || (this.rtspStartAttempted && this.rtspSessionId && this.rtspRuntime)) {
      try {
        if (this.rtspHandle) {
          await withOptionalMonotonicDeadline(
            this.rtspHandle.stop(deadlineMonotonicMs), deadlineMonotonicMs,
            this.monotonicNow, 'RTSP runtime cleanup timed out',
          );
        } else {
          await withOptionalMonotonicDeadline(
            this.rtspRuntime!.recover(this.rtspSessionId!, deadlineMonotonicMs),
            deadlineMonotonicMs, this.monotonicNow, 'RTSP recovery timed out',
          );
        }
        this.rtspHandle = undefined;
        this.rtspStartAttempted = false;
        this.rtspSessionId = undefined;
      } catch (error) {
        cleanupError = error;
      }
    }
    const producerSocket = this.producerSocket;
    if (producerSocket) {
      try {
        await withOptionalMonotonicDeadline(
          closeProducerSocket(producerSocket), deadlineMonotonicMs, this.monotonicNow,
          'RTSP producer close timed out', this.stopGraceMs,
        );
        if (this.producerSocket === producerSocket) this.producerSocket = undefined;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    const producerServer = this.producerServer;
    if (producerServer) {
      try {
        if (this.producerListen && !this.producerListenSettled) {
          await withOptionalMonotonicDeadline(
            this.producerListen, deadlineMonotonicMs, this.monotonicNow,
            'RTSP listener startup cleanup timed out', this.stopGraceMs,
          );
        }
        this.producerServerClose ??= closeProducerServer(producerServer);
        await withOptionalMonotonicDeadline(
          this.producerServerClose, deadlineMonotonicMs, this.monotonicNow,
          'RTSP listener close timed out', this.stopGraceMs,
        );
        if (this.producerServer === producerServer) this.producerServer = undefined;
        this.producerServerClose = undefined;
        this.producerListen = undefined;
        this.producerListenSettled = false;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    const producerPath = this.producerPath;
    if (producerPath && !this.producerServer) {
      try {
        await this.unlinkRtspSocket(producerPath);
        this.producerPath = undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.producerPath = undefined;
        else cleanupError ??= error;
      }
    }
    this.producerAccepted = false;
    this.rtspReady = false;
    this.frameReady = undefined;
    this.resolveFrameReady = undefined;
    this.rejectFrameReady = undefined;
    this.upstreamRequest?.destroy();
    this.upstreamResponse?.destroy();
    this.upstreamRequest = undefined;
    this.upstreamResponse = undefined;
    this.upstreamBoundary = undefined;
    this.upstreamOpened = false;
    this.upstreamUnavailable = false;
    this.frameBuffer = Buffer.alloc(0);
    for (const viewer of [...this.activeViewers]) viewer.response.destroy();
    this.activeViewers.clear();
    this.viewers.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const child = this.child;
    const identity = this.childIdentity;
    const groupValidated = this.childGroupValidated;
    this.child = undefined;
    this.childIdentity = undefined;
    this.childGroupValidated = false;
    if (child?.pid) {
      const terminated = identity
        ? await this.terminateVerifiedGroup(child.pid, identity, child)
        : false;
      if (!terminated && !groupValidated) child.kill('SIGTERM');
      this.outputMonitor?.close();
      this.outputMonitor = undefined;
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
    }
    this.outputMonitor?.close();
    this.outputMonitor = undefined;
    this.source = undefined;
    if (cleanupError) throw new Error('Live stream cleanup incomplete');
  }

  recoverOwnedProcess(input: {
    sessionId: string;
    sourceKind: LiveStreamSource['kind'];
    pid: LiveStreamProcessId;
    processIdentity: string;
  }): Promise<'stopped' | 'not-owned'> {
    return this.enqueueLifecycle(() => this.recoverExclusive(input));
  }

  private async recoverExclusive(input: {
    sessionId: string;
    sourceKind: LiveStreamSource['kind'];
    pid: LiveStreamProcessId;
    processIdentity: string;
  }): Promise<'stopped' | 'not-owned'> {
    const runtimeRecovery = input.sourceKind === 'rtsp'
      ? this.rtspRuntime?.recover(input.sessionId) ?? Promise.resolve()
      : Promise.resolve();
    const socketRecovery = input.sourceKind === 'rtsp' && input.sessionId
      ? this.removeRecoveredRtspSocket(input.sessionId)
      : Promise.resolve();
    const cloudRecovery = this.recoverCloudflared(input.pid, input.processIdentity);
    const [runtimeResult, socketResult, cloudResult] = await Promise.allSettled([
      runtimeRecovery, socketRecovery, cloudRecovery,
    ]);
    if (runtimeResult.status === 'rejected' || socketResult.status === 'rejected' || cloudResult.status === 'rejected') {
      throw new Error('Live stream recovery incomplete');
    }
    return cloudResult.value;
  }

  private async removeRecoveredRtspSocket(sessionId: string): Promise<void> {
    if (!SESSION_UUID.test(sessionId)) throw new Error('Invalid RTSP recovery identity');
    try {
      await this.inspectRtspDirectory(this.rtspSocketDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const path = `${this.rtspSocketDirectory}/${sessionId.toLowerCase()}.sock`;
    try {
      await this.inspectRtspSocket(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      await this.unlinkRtspSocket(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async recoverCloudflared(
    opaquePid: LiveStreamProcessId,
    identity: string,
  ): Promise<'stopped' | 'not-owned'> {
    const pid = Number(opaquePid);
    if (!(await this.isDetachedProcessGroup(pid))) return 'not-owned';
    const current = await this.identifyProcess(pid);
    if (!current || current !== identity) return 'not-owned';
    return (await this.terminateVerifiedGroup(pid, identity)) ? 'stopped' : 'not-owned';
  }

  private async openLoopbackServer(): Promise<void> {
    this.server = createServer((request, response) => this.handleRequest(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  private async openRtspProducer(sessionId: string, deadlineMonotonicMs: number): Promise<void> {
    if (!SESSION_UUID.test(sessionId)) {
      throw new Error('Invalid RTSP session identity');
    }
    await withMonotonicDeadline(
      this.inspectRtspDirectory(this.rtspSocketDirectory),
      deadlineMonotonicMs,
      this.monotonicNow,
      'RTSP output directory inspection timed out',
    );
    const path = `${this.rtspSocketDirectory}/${sessionId.toLowerCase()}.sock`;
    this.producerPath = path;
    this.frameReady = new Promise<void>((resolve, reject) => {
      this.resolveFrameReady = resolve;
      this.rejectFrameReady = reject;
    });
    void this.frameReady.catch(() => undefined);
    this.producerServer = createUnixServer((socket) => this.acceptProducer(socket));
    this.producerListenSettled = false;
    this.producerListen = new Promise<void>((resolve, reject) => {
      this.producerServer!.once('error', reject);
      this.producerServer!.listen(path, () => {
        this.producerServer!.off('error', reject);
        resolve();
      });
    });
    void this.producerListen.then(
      () => { this.producerListenSettled = true; },
      () => { this.producerListenSettled = true; },
    );
    await withMonotonicDeadline(
      this.producerListen, deadlineMonotonicMs, this.monotonicNow,
      'RTSP listener startup timed out',
    );
    await withMonotonicDeadline(
      this.chmodRtspSocket(path, 0o660), deadlineMonotonicMs, this.monotonicNow,
      'RTSP socket permission update timed out',
    );
    await withMonotonicDeadline(
      this.inspectRtspSocket(path), deadlineMonotonicMs, this.monotonicNow,
      'RTSP socket inspection timed out',
    );
  }

  private acceptProducer(socket: Socket): void {
    if (this.producerAccepted) {
      socket.destroy();
      this.rejectFrameReady?.(new Error('Second RTSP producer rejected'));
      return;
    }
    this.producerAccepted = true;
    this.producerSocket = socket;
    socket.on('data', (chunk: Buffer) => this.consumeRawJpeg(chunk));
    const failed = () => {
      this.rejectFrameReady?.(new Error('RTSP producer ended before readiness'));
      this.closeAllViewers();
      this.handleTerminalRtspFailure();
    };
    socket.once('error', failed);
    socket.once('end', failed);
    socket.once('close', () => {
      if (this.producerSocket === socket) this.producerSocket = undefined;
    });
  }

  private consumeRawJpeg(chunk: Buffer): void {
    if (this.frameBuffer.length + chunk.length > FRAME_BUFFER_LIMIT_BYTES) {
      this.rejectFrameReady?.(new Error('RTSP frame exceeded bounded limit'));
      this.producerSocket?.destroy();
      this.closeAllViewers();
      this.handleTerminalRtspFailure();
      return;
    }
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    while (true) {
      const start = this.frameBuffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.frameBuffer = this.frameBuffer.subarray(Math.max(0, this.frameBuffer.length - 1));
        return;
      }
      if (start > 0) this.frameBuffer = this.frameBuffer.subarray(start);
      const end = this.frameBuffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) return;
      const jpeg = this.frameBuffer.subarray(0, end + 2);
      this.frameBuffer = this.frameBuffer.subarray(end + 2);
      this.resolveFrameReady?.();
      this.resolveFrameReady = undefined;
      this.rejectFrameReady = undefined;
      this.broadcast(Buffer.concat([
        Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpeg.length + '\r\n\r\n'),
        jpeg,
        Buffer.from('\r\n'),
      ]));
    }
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    Object.entries(SECURITY_HEADERS).forEach(([name, value]) => response.setHeader(name, value));
    if (request.method !== 'GET') return notFound(response);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const match = /^\/(watch|clean-page|mjpeg)\/([^/]+)$/.exec(url.pathname);
    if (!match || url.search) return notFound(response);
    let token: string;
    try {
      token = decodeURIComponent(match[2]);
    } catch {
      return notFound(response);
    }
    const tokenHash = this.authorizedTokenHash(token);
    if (!tokenHash) return notFound(response);
    if (match[1] === 'mjpeg') return this.openViewer(tokenHash, response);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><meta name="referrer" content="no-referrer"><title></title><style>html,body{margin:0;background:#000}img{width:100%;height:100vh;object-fit:contain}</style><img src="/mjpeg/${encodeURIComponent(token)}" alt="">`,
    );
  }

  private authorizedTokenHash(token: string): string | null {
    const candidate = hashToken(token);
    for (const [storedHash, viewer] of this.viewers) {
      if (viewer.expiresMonotonicMs <= performance.now()) continue;
      if (safeHashEqual(candidate, storedHash)) return storedHash;
    }
    return null;
  }

  private openViewer(tokenHash: string, response: ServerResponse): void {
    if (this.upstreamUnavailable || this.activeViewers.size >= this.maxViewers) {
      return notFound(response);
    }
    for (const viewer of this.activeViewers) {
      if (safeHashEqual(viewer.tokenHash, tokenHash)) return notFound(response);
    }
    const active: ActiveViewer = { tokenHash, response, queue: [], draining: false };
    this.activeViewers.add(active);
    response.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frame',
      connection: 'close',
    });
    response.flushHeaders();
    const remove = () => {
      this.activeViewers.delete(active);
    };
    response.once('close', remove);
    response.once('error', remove);
    response.on('drain', () => this.flushViewer(active));
    this.ensureUpstream();
  }

  private ensureUpstream(): void {
    if (this.upstreamOpened || !this.source) return;
    if (this.source.kind === 'rtsp') return;
    this.upstreamOpened = true;
    this.upstreamRequest = httpGet(this.source.upstreamUrl, (upstream) => {
      this.upstreamResponse = upstream;
      if (upstream.statusCode !== 200) return this.closeAllViewers();
      const contentType = upstream.headers['content-type'] ?? '';
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
      if (!boundaryMatch) return this.closeAllViewers();
      const boundary = boundaryMatch[1] ?? boundaryMatch[2];
      this.upstreamBoundary = Buffer.from(`--${boundary}`);
      upstream.on('data', (chunk: Buffer) => this.consumeUpstreamChunk(chunk));
      upstream.once('end', () => this.closeAllViewers());
      upstream.once('error', () => this.closeAllViewers());
    });
    this.upstreamRequest.once('error', () => this.closeAllViewers());
  }

  private consumeUpstreamChunk(chunk: Buffer): void {
    const boundary = this.upstreamBoundary;
    if (!boundary) return;
    if (this.frameBuffer.length + chunk.length > FRAME_BUFFER_LIMIT_BYTES) {
      this.closeAllViewers();
      return;
    }
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    let first = this.frameBuffer.indexOf(boundary);
    if (first < 0) return;
    if (first > 0) this.frameBuffer = this.frameBuffer.subarray(first);
    while ((first = this.frameBuffer.indexOf(boundary)) === 0) {
      const next = this.frameBuffer.indexOf(boundary, boundary.length);
      if (next < 0) return;
      const upstreamFrame = this.frameBuffer.subarray(0, next);
      const frame = Buffer.concat([
        Buffer.from('--frame'),
        upstreamFrame.subarray(boundary.length),
      ]);
      this.frameBuffer = this.frameBuffer.subarray(next);
      if (upstreamFrame.length > boundary.length) this.broadcast(frame);
    }
  }

  private broadcast(frame: Buffer): void {
    for (const viewer of [...this.activeViewers]) {
      if (viewer.draining) {
        if (viewer.queue.length >= VIEWER_QUEUE_LIMIT) {
          viewer.response.destroy();
        } else {
          viewer.queue.push(frame);
        }
        continue;
      }
      if (!viewer.response.write(frame)) viewer.draining = true;
    }
  }

  private flushViewer(viewer: ActiveViewer): void {
    viewer.draining = false;
    while (viewer.queue.length > 0) {
      const frame = viewer.queue.shift()!;
      if (!viewer.response.write(frame)) {
        viewer.draining = true;
        return;
      }
    }
  }

  private closeUpstream(): void {
    this.upstreamRequest?.destroy();
    this.upstreamResponse?.destroy();
    this.upstreamRequest = undefined;
    this.upstreamResponse = undefined;
    this.upstreamBoundary = undefined;
    this.frameBuffer = Buffer.alloc(0);
  }

  private closeAllViewers(): void {
    this.upstreamUnavailable = true;
    for (const viewer of [...this.activeViewers]) viewer.response.destroy();
    this.closeUpstream();
  }

  private async terminateVerifiedGroup(
    pid: number,
    identity: string,
    child?: CloudflaredChild,
  ): Promise<boolean> {
    if (!(await this.isDetachedProcessGroup(pid))) return false;
    if ((await this.identifyProcess(pid)) !== identity) return false;
    if (this.signalProcessGroup(pid, 'SIGTERM') === false) return false;
    if (this.stopGraceMs <= 0) return true;
    const exited = child ? await waitForExit(child, this.stopGraceMs) : await waitUntilGone(pid, identity, this.identifyProcess, this.stopGraceMs);
    if (exited || !(await this.isDetachedProcessGroup(pid)) || (await this.identifyProcess(pid)) !== identity) return true;
    this.signalProcessGroup(pid, 'SIGKILL');
    return true;
  }

  private async isDetachedProcessGroup(pid: number): Promise<boolean> {
    const processGroupId = await this.processGroupId(pid);
    return processGroupId === pid && processGroupId !== this.workerProcessGroupId;
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private handleTerminalRtspFailure(): void {
    if (!this.rtspReady) return;
    this.rtspReady = false;
    void this.enqueueLifecycle(() => this.cleanupExclusive())
      .finally(() => this.failureHandler?.())
      .catch(() => undefined);
  }

  private async retryStartupCleanupUntilComplete(): Promise<void> {
    while (true) {
      try {
        await this.cleanupExclusive();
        return;
      } catch {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(10, this.stopGraceMs));
          timer.unref();
        });
      }
    }
  }

  private async fenceLateRuntimeStart(
    runtimeStart: Promise<RtspStreamRuntimeHandle>,
    sessionId: string,
    expiredDeadlineMonotonicMs: number,
  ): Promise<void> {
    try {
      await this.cleanupExclusive(expiredDeadlineMonotonicMs);
    } catch {
      await this.retryStartupCleanupUntilComplete();
    }

    let lateHandle: RtspStreamRuntimeHandle;
    try {
      lateHandle = await runtimeStart;
    } catch {
      return;
    }
    this.rtspSessionId = sessionId;
    this.rtspStartAttempted = true;
    this.rtspHandle = lateHandle;
    await this.retryStartupCleanupUntilComplete();
  }
}

class CloudflaredOutputMonitor {
  readonly hostname: Promise<string>;
  readonly failure: Promise<never>;
  private resolveHostname!: (hostname: string) => void;
  private rejectFailure!: (error: Error) => void;
  private retained = Buffer.alloc(0);
  private hostnameResolved = false;
  private failed = false;
  private scanning = true;

  constructor(private readonly child: CloudflaredChild) {
    this.hostname = new Promise<string>((resolve) => {
      this.resolveHostname = resolve;
    });
    this.failure = new Promise<never>((_, reject) => {
      this.rejectFailure = reject;
    });
    child.stdout.on('data', this.onData);
    child.stderr.on('data', this.onData);
    child.once('exit', this.onExit);
    child.once('error', this.onError);
  }

  beginDrain(): void {
    this.scanning = false;
    this.retained = Buffer.alloc(0);
  }

  close(): void {
    this.child.stdout.off('data', this.onData);
    this.child.stderr.off('data', this.onData);
    this.child.off('exit', this.onExit);
    this.child.off('error', this.onError);
    this.retained = Buffer.alloc(0);
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (!this.scanning || this.failed) return;
    const next = Buffer.from(chunk);
    if (this.retained.length + next.length > OUTPUT_LIMIT_BYTES) {
      this.fail(new Error('Quick Tunnel output exceeded its bounded limit'));
      return;
    }
    this.retained = Buffer.concat([this.retained, next]);
    const text = this.retained.toString('utf8');
    const matches = [...text.matchAll(/https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com)(?=[\s/]|$)/gi)];
    if (matches.length > 1) {
      this.fail(new Error('Quick Tunnel emitted duplicate hostname data'));
      return;
    }
    if (matches.length === 1 && !this.hostnameResolved) {
      this.hostnameResolved = true;
      this.resolveHostname(matches[0][1].toLowerCase());
    }
  };

  private readonly onExit = (): void => {
    this.fail(new Error('Quick Tunnel exited before readiness'));
  };

  private readonly onError = (error: Error): void => {
    this.fail(error);
  };

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.rejectFailure(error);
  }
}

function createCloudflaredOutputMonitor(child: CloudflaredChild): CloudflaredOutputMonitor {
  return new CloudflaredOutputMonitor(child);
}

function defaultSpawn(args: string[], options: SpawnOptions): CloudflaredChild {
  return spawn('cloudflared', args, options) as CloudflaredChild;
}

async function defaultPublicProbe(input: { hostname: string; path: string }): Promise<void> {
  const response = await fetch(`https://${input.hostname}${input.path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Quick Tunnel readiness probe failed');
  await response.body?.cancel();
}

function defaultSignalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function linuxProcessIdentity(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fields = stat.slice(closeParen + 2).split(' ');
    const startTicks = fields[19];
    const executable = await readlink(`/proc/${pid}/exe`);
    return startTicks && executable ? `${startTicks}:${executable}` : null;
  } catch {
    return null;
  }
}

async function linuxProcessGroupId(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return null;
    const processGroupId = Number(stat.slice(closeParen + 2).split(' ')[2]);
    return Number.isSafeInteger(processGroupId) && processGroupId > 0
      ? processGroupId
      : null;
  } catch {
    return null;
  }
}

function readOwnProcessGroupId(): number {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const closeParen = stat.lastIndexOf(')');
    const fields = stat.slice(closeParen + 2).split(' ');
    const processGroupId = Number(fields[2]);
    return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : process.pid;
  } catch {
    return process.pid;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeHashEqual(left: string, right: string): boolean {
  if (!isSha256Hex(left) || !isSha256Hex(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function notFound(response: ServerResponse): void {
  response.writeHead(404);
  response.end();
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withMonotonicDeadline<T>(
  promise: Promise<T>,
  deadlineMonotonicMs: number,
  monotonicNow: () => number,
  message: string,
): Promise<T> {
  const remainingMs = deadlineMonotonicMs - monotonicNow();
  if (remainingMs <= 0) {
    void promise.catch(() => undefined);
    throw new MonotonicDeadlineError(message);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MonotonicDeadlineError(message)), remainingMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class MonotonicDeadlineError extends Error {}

function withOptionalMonotonicDeadline<T>(
  promise: Promise<T>,
  deadlineMonotonicMs: number | undefined,
  monotonicNow: () => number,
  message: string,
  fallbackTimeoutMs?: number,
): Promise<T> {
  if (deadlineMonotonicMs !== undefined) {
    return withMonotonicDeadline(promise, deadlineMonotonicMs, monotonicNow, message);
  }
  return fallbackTimeoutMs === undefined
    ? promise
    : withTimeout(promise, Math.max(1, fallbackTimeoutMs), message);
}

async function closeProducerSocket(socket: Socket): Promise<void> {
  if (socket.closed) return;
  await new Promise<void>((resolve) => {
    socket.once('close', resolve);
    socket.destroy();
  });
}

async function closeProducerServer(server: NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitForExit(child: CloudflaredChild, milliseconds: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, milliseconds);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function waitUntilGone(
  pid: number,
  identity: string,
  identify: (pid: number) => Promise<string | null>,
  milliseconds: number,
): Promise<boolean> {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if ((await identify(pid)) !== identity) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, milliseconds)));
  }
  return false;
}

async function inspectRestrictedOutputDirectory(path: string): Promise<void> {
  const value = await lstat(path);
  const groups = typeof process.getgroups === 'function' ? process.getgroups() : [];
  if (!value.isDirectory() || value.isSymbolicLink() || (value.mode & 0o7777) !== 0o3770 ||
      value.uid !== 0 || !groups.includes(value.gid)) {
    throw new Error('Unsafe RTSP output directory');
  }
}

async function inspectGatewayOwnedSocket(path: string): Promise<void> {
  const value = await lstat(path);
  const groups = typeof process.getgroups === 'function' ? process.getgroups() : [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (!value.isSocket() || value.isSymbolicLink() || (value.mode & 0o777) !== 0o660 ||
      value.uid !== uid || !groups.includes(value.gid)) {
    throw new Error('Unsafe RTSP producer socket');
  }
}
