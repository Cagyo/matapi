import { Injectable } from '@nestjs/common';
import { spawn, type SpawnOptions } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { readFile, readlink } from 'node:fs/promises';
import {
  get as httpGet,
  createServer,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Readable } from 'node:stream';
import {
  createLiveStreamProcessId,
  type LiveStreamProcessId,
  type LiveStreamSource,
  type LiveStreamViewer,
} from '../domain/live-stream.entity';
import type { LiveStreamGatewayPort } from '../domain/ports/live-stream-gateway.port';

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const FRAME_BUFFER_LIMIT_BYTES = 2 * 1024 * 1024;
const VIEWER_QUEUE_LIMIT = 2;
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
} as const;

export interface CloudflaredChild extends EventEmitter {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
}

export interface QuickTunnelLiveStreamDependencies {
  spawnCloudflared?: (
    args: string[],
    options: SpawnOptions,
  ) => CloudflaredChild;
  publicProbe?: (input: { hostname: string; path: string }) => Promise<void>;
  identifyProcess?: (pid: number) => Promise<string | null>;
  processGroupId?: (pid: number) => Promise<number | null>;
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  workerProcessGroupId?: number;
  startupTimeoutMs?: number;
  stopGraceMs?: number;
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
  private readonly viewers = new Map<string, LiveStreamViewer>();
  private readonly activeViewers = new Set<ActiveViewer>();
  private server?: Server;
  private child?: CloudflaredChild;
  private childIdentity?: string;
  private source?: LiveStreamSource;
  private upstreamRequest?: ClientRequest;
  private upstreamResponse?: IncomingMessage;
  private upstreamBoundary?: Buffer;
  private upstreamOpened = false;
  private frameBuffer = Buffer.alloc(0);

  constructor(dependencies: QuickTunnelLiveStreamDependencies = {}) {
    this.spawnCloudflared = dependencies.spawnCloudflared ?? defaultSpawn;
    this.publicProbe = dependencies.publicProbe ?? defaultPublicProbe;
    this.identifyProcess = dependencies.identifyProcess ?? linuxProcessIdentity;
    this.processGroupId = dependencies.processGroupId ?? linuxProcessGroupId;
    this.signalProcessGroup = dependencies.signalProcessGroup ?? defaultSignalProcessGroup;
    this.workerProcessGroupId = dependencies.workerProcessGroupId ?? readOwnProcessGroupId();
    this.startupTimeoutMs = dependencies.startupTimeoutMs ?? 30_000;
    this.stopGraceMs = dependencies.stopGraceMs ?? 2_000;
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

  async start(input: { source: LiveStreamSource }): ReturnType<LiveStreamGatewayPort['start']> {
    if (this.server || this.child) throw new Error('Live stream gateway is already running');
    this.source = input.source;
    try {
      await this.openLoopbackServer();
      const origin = this.localOrigin;
      if (!origin) throw new Error('Loopback listener did not publish an address');
      const child = this.spawnCloudflared(
        ['tunnel', '--url', origin, '--no-autoupdate'],
        { detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      this.child = child;
      const hostnamePromise = this.readSingleHostname(child);
      void hostnamePromise.catch(() => undefined);
      if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
        throw new Error('Cloudflared did not publish a valid process identifier');
      }
      if (!(await this.isDetachedProcessGroup(child.pid))) {
        throw new Error('Cloudflared process group is not detached from the worker');
      }
      const processIdentity = await this.identifyProcess(child.pid);
      if (!processIdentity) throw new Error('Cloudflared process identity is unavailable');
      this.childIdentity = processIdentity;
      const hostname = await hostnamePromise;
      const readinessToken = randomBytes(32).toString('base64url');
      const readinessHash = hashToken(readinessToken);
      this.viewers.set(readinessHash, {
        tokenHash: readinessHash,
        telegramId: 0,
        expiresMonotonicMs: Number.MAX_SAFE_INTEGER,
      });
      try {
        await withTimeout(
          this.publicProbe({ hostname, path: `/watch/${readinessToken}` }),
          this.startupTimeoutMs,
          'Quick Tunnel did not become externally ready',
        );
      } finally {
        this.viewers.delete(readinessHash);
      }
      return {
        publicHostname: hostname,
        pid: createLiveStreamProcessId(child.pid),
        processIdentity,
      };
    } catch (error) {
      await this.stop();
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

  async stop(): Promise<void> {
    this.upstreamRequest?.destroy();
    this.upstreamResponse?.destroy();
    this.upstreamRequest = undefined;
    this.upstreamResponse = undefined;
    this.upstreamBoundary = undefined;
    this.upstreamOpened = false;
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
    this.child = undefined;
    this.childIdentity = undefined;
    if (child?.pid && identity) {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      await this.terminateVerifiedGroup(child.pid, identity, child);
    }
    this.source = undefined;
  }

  async recoverOwnedProcess(input: {
    pid: LiveStreamProcessId;
    processIdentity: string;
  }): Promise<'stopped' | 'not-owned'> {
    const pid = Number(input.pid);
    if (!(await this.isDetachedProcessGroup(pid))) return 'not-owned';
    const current = await this.identifyProcess(pid);
    if (!current || current !== input.processIdentity) return 'not-owned';
    await this.terminateVerifiedGroup(pid, input.processIdentity);
    return 'stopped';
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
      `<!doctype html><meta name="referrer" content="no-referrer"><title>Live camera</title><style>html,body{margin:0;background:#000}img{width:100%;height:100vh;object-fit:contain}</style><img src="/mjpeg/${encodeURIComponent(token)}" alt="Live camera">`,
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
    if (this.activeViewers.size >= 2) return notFound(response);
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
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    if (this.frameBuffer.length > FRAME_BUFFER_LIMIT_BYTES) return this.closeAllViewers();
    let first = this.frameBuffer.indexOf(boundary);
    if (first < 0) return;
    if (first > 0) this.frameBuffer = this.frameBuffer.subarray(first);
    while ((first = this.frameBuffer.indexOf(boundary)) === 0) {
      const next = this.frameBuffer.indexOf(boundary, boundary.length);
      if (next < 0) return;
      const frame = Buffer.from(this.frameBuffer.subarray(0, next));
      this.frameBuffer = this.frameBuffer.subarray(next);
      if (frame.length > boundary.length) this.broadcast(frame);
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
    for (const viewer of [...this.activeViewers]) viewer.response.destroy();
    this.closeUpstream();
  }

  private readSingleHostname(child: CloudflaredChild): Promise<string> {
    return withTimeout(
      new Promise<string>((resolve, reject) => {
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let settled = false;
        const inspect = () => {
          const combined = Buffer.concat([stdout, stderr]).toString('utf8');
          const matches = [...combined.matchAll(/https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com)(?=[\s/]|$)/gi)];
          const hostnames = new Set(matches.map((match) => match[1].toLowerCase()));
          if (matches.length > 1 || hostnames.size > 1) return finish(new Error('Quick Tunnel emitted duplicate hostname data'));
          if (hostnames.size === 1) queueMicrotask(() => {
            const latest = Buffer.concat([stdout, stderr]).toString('utf8');
            const all = [...latest.matchAll(/https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com)(?=[\s/]|$)/gi)];
            if (all.length !== 1) finish(new Error('Quick Tunnel emitted duplicate hostname data'));
            else finish(undefined, all[0][1].toLowerCase());
          });
        };
        const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
          const next = Buffer.from(chunk);
          if ((target === 'stdout' ? stdout.length : stderr.length) + next.length > OUTPUT_LIMIT_BYTES) {
            return finish(new Error('Quick Tunnel output exceeded its bounded limit'));
          }
          if (target === 'stdout') stdout = Buffer.concat([stdout, next]);
          else stderr = Buffer.concat([stderr, next]);
          inspect();
        };
        const finish = (error?: Error, hostname?: string) => {
          if (settled) return;
          settled = true;
          child.stdout.off('data', onStdout);
          child.stderr.off('data', onStderr);
          child.off('exit', onExit);
          child.off('error', onError);
          if (error) reject(error);
          else resolve(hostname!);
        };
        const onStdout = (chunk: Buffer | string) => append('stdout', chunk);
        const onStderr = (chunk: Buffer | string) => append('stderr', chunk);
        const onExit = () => finish(new Error('Quick Tunnel exited before publishing a hostname'));
        const onError = (error: Error) => finish(error);
        child.stdout.on('data', onStdout);
        child.stderr.on('data', onStderr);
        child.once('exit', onExit);
        child.once('error', onError);
      }),
      this.startupTimeoutMs,
      'Quick Tunnel hostname timed out',
    );
  }

  private async terminateVerifiedGroup(
    pid: number,
    identity: string,
    child?: CloudflaredChild,
  ): Promise<void> {
    if (!(await this.isDetachedProcessGroup(pid))) return;
    if ((await this.identifyProcess(pid)) !== identity) return;
    this.signalProcessGroup(pid, 'SIGTERM');
    if (this.stopGraceMs <= 0) return;
    const exited = child ? await waitForExit(child, this.stopGraceMs) : await waitUntilGone(pid, identity, this.identifyProcess, this.stopGraceMs);
    if (exited || !(await this.isDetachedProcessGroup(pid)) || (await this.identifyProcess(pid)) !== identity) return;
    this.signalProcessGroup(pid, 'SIGKILL');
  }

  private async isDetachedProcessGroup(pid: number): Promise<boolean> {
    const processGroupId = await this.processGroupId(pid);
    return processGroupId === pid && processGroupId !== this.workerProcessGroupId;
  }
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

function defaultSignalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
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
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
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
