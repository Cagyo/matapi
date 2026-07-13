import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LiveSourceNetworkPolicyInvalidError } from '../domain/errors/live-source-network-policy-invalid.error';
import { LiveSourceProbeFailedError } from '../domain/errors/live-source-probe-failed.error';
import type { LiveSource } from '../domain/live-source.entity';
import type { LiveSourceProbePort } from '../domain/ports/live-source-probe.port';
import type {
  StreamEgressLease,
  StreamEgressPort,
} from '../domain/ports/stream-egress.port';
import { StreamEgressGrant } from '../domain/stream-egress-grant.value-object';

const PROTOCOL_WHITELIST = 'rtp,rtsp,tcp,tls,udp,unix';
const MAX_DIAGNOSTIC_BYTES = 65_536;
const MAX_PROBE_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_CLEANUP_RESERVE_MS = 500;

export class BoundedJpegFrameTracker {
  #previousByte = -1;
  #sawStart = false;
  #sawFrame = false;
  #receivedBytes = 0;
  #finished = false;
  readonly #observed: Promise<void>;
  readonly #resolveObserved: () => void;

  constructor() {
    let resolveObserved!: () => void;
    this.#observed = new Promise<void>((resolve) => {
      resolveObserved = resolve;
    });
    this.#resolveObserved = resolveObserved;
  }

  accept(chunk: Uint8Array): void {
    this.#receivedBytes += chunk.byteLength;
    if (this.#receivedBytes > MAX_PROBE_FRAME_BYTES) {
      this.#finished = true;
      this.#resolveObserved();
      throw new LiveSourceProbeFailedError();
    }
    for (const byte of chunk) {
      if (this.#previousByte === 0xff && byte === 0xd8) this.#sawStart = true;
      if (this.#sawStart && this.#previousByte === 0xff && byte === 0xd9) {
        this.#sawFrame = true;
        this.#resolveObserved();
      }
      this.#previousByte = byte;
    }
  }

  confirm(): void {
    if (!this.#sawFrame) throw new LiveSourceProbeFailedError();
  }

  finish(): void {
    this.#finished = true;
    this.#resolveObserved();
  }

  async waitForFrame(timeoutMs: number): Promise<void> {
    if (this.#sawFrame) return;
    if (this.#finished) throw new LiveSourceProbeFailedError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#observed,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new LiveSourceProbeFailedError()),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.confirm();
  }
}

export interface FfmpegLiveSourceProbeOptions {
  allowedCidrs: string;
  runtimeDirectory: string;
  timeoutMs: number;
  udpPortFirst: number;
  udpPortLast: number;
  caFile?: string;
}

export function liveSourceProbeOptionsFromEnvironment(
  env: Record<string, string | undefined>,
): FfmpegLiveSourceProbeOptions | null {
  if (!env.RTSP_ALLOWED_CIDRS) return null;
  return {
    allowedCidrs: env.RTSP_ALLOWED_CIDRS,
    runtimeDirectory:
      env.RTSP_PROBE_RUNTIME_DIR ?? '/run/home-worker/live-source-probe',
    timeoutMs: strictInteger(env.RTSP_PROBE_TIMEOUT_MS, 30_000),
    udpPortFirst: strictInteger(env.RTSP_UDP_PORT_FIRST, 24_000),
    udpPortLast: strictInteger(env.RTSP_UDP_PORT_LAST, 24_001),
    ...(env.RTSP_TLS_CA_FILE ? { caFile: env.RTSP_TLS_CA_FILE } : {}),
  };
}

export interface UnixSink {
  confirmFrame(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface UnixSinkSetupDependencies {
  mkdir(
    path: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  createServer(
    onConnection: (socket: Socket) => void,
  ): UnixSinkServer;
}

export interface UnixSinkServer {
  readonly listening: boolean;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  listen(path: string, listener: () => void): void;
  close(listener: () => void): void;
}

export interface FfmpegLiveSourceProbeDependencies {
  lookup(hostname: string): Promise<readonly { address: string; family: number }[]>;
  startProcess(
    file: string,
    args: readonly string[],
    options: { maxBuffer: number; shell: false },
  ): ProbeProcessHandle;
  openUnixSink(path: string): Promise<UnixSink>;
  monotonicNow(): number;
  wallNow(): number;
  randomUUID(): string;
  randomBytes(): Buffer;
}

export interface ProbeProcessHandle {
  readonly completion: Promise<void>;
  kill(signal: NodeJS.Signals): void;
}

export class FfmpegLiveSourceProbeAdapter implements LiveSourceProbePort {
  readonly #cidrs: readonly ParsedCidr[];
  readonly #dependencies: FfmpegLiveSourceProbeDependencies;

  constructor(
    private readonly egress: StreamEgressPort,
    private readonly options: FfmpegLiveSourceProbeOptions,
    dependencies: Partial<FfmpegLiveSourceProbeDependencies> = {},
  ) {
    this.#cidrs = parseCidrs(options.allowedCidrs);
    if (
      !isSafeRuntimeDirectory(options.runtimeDirectory) ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1_000 ||
      options.timeoutMs > 120_000 ||
      !isPort(options.udpPortFirst) ||
      !isPort(options.udpPortLast) ||
      options.udpPortFirst > options.udpPortLast ||
      options.udpPortLast - options.udpPortFirst > 63
    ) {
      throw new LiveSourceNetworkPolicyInvalidError();
    }
    this.#dependencies = {
      lookup: dependencies.lookup ?? defaultLookup,
      startProcess: dependencies.startProcess ?? startFfmpegProbeProcess,
      openUnixSink: dependencies.openUnixSink ?? openFfmpegProbeUnixSink,
      monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
      wallNow: dependencies.wallNow ?? Date.now,
      randomUUID: dependencies.randomUUID ?? randomUUID,
      randomBytes: dependencies.randomBytes ?? (() => randomBytes(32)),
    };
  }

  async run(source: LiveSource): Promise<void> {
    const monotonicNow = () => this.#dependencies.monotonicNow();
    const startedAt = monotonicNow();
    const finalDeadline = startedAt + this.options.timeoutMs;
    const cleanupReserveMs = Math.min(
      MAX_CLEANUP_RESERVE_MS,
      Math.floor(this.options.timeoutMs / 4),
    );
    const workDeadline = finalDeadline - cleanupReserveMs;
    let lease: StreamEgressLease | undefined;
    let sink: UnixSink | undefined;
    let process: ProbeProcessHandle | undefined;
    let processCompletion: Promise<void> | undefined;
    let processSettled = false;
    let failed = false;
    try {
      const payload = source.credentialPayload();
      const endpoints = [payload.primaryUrl, payload.substreamUrl].filter(
        (value): value is string => value !== null,
      );
      const selectedUrl =
        source.profile === 'eco' && payload.substreamUrl
          ? payload.substreamUrl
          : payload.primaryUrl;
      const validatedEndpoints = await awaitBeforeDeadline(
        Promise.all(endpoints.map((endpoint) => this.validateEndpoint(endpoint))),
        workDeadline,
        monotonicNow,
      );
      const selected = validatedEndpoints.find(
        (endpoint) => endpoint.raw === selectedUrl,
      );
      if (!selected) throw new LiveSourceProbeFailedError();
      const effectiveTransport =
        source.transport === 'auto' ? 'tcp' : source.transport;
      const wallNow = this.#dependencies.wallNow();
      const sessionId = this.#dependencies.randomUUID();
      const nonceHash = createHash('sha256')
        .update(this.#dependencies.randomBytes())
        .digest('hex');
      const baseGrant = {
          sessionId,
          nonceHash,
          addresses: selected.addresses,
          rtspControlPorts: [selected.port],
          expiresAtUnixMs: wallNow + this.options.timeoutMs,
        };
      const grant = StreamEgressGrant.create(
        effectiveTransport === 'tcp'
          ? { ...baseGrant, transport: 'tcp' }
          : {
              ...baseGrant,
              transport: effectiveTransport,
              udpMediaPorts: {
                first: this.options.udpPortFirst,
                last: this.options.udpPortLast,
              },
            },
        wallNow,
      );
      lease = await awaitBeforeDeadline(
        this.egress.grant(grant),
        workDeadline,
        monotonicNow,
        (lateLease) => this.egress.revoke(lateLease),
      );
      const socketPath = join(
        this.options.runtimeDirectory,
        `probe-${sessionId}.sock`,
      );
      sink = await awaitBeforeDeadline(
        this.#dependencies.openUnixSink(socketPath),
        workDeadline,
        monotonicNow,
        (lateSink) => lateSink.close(),
      );
      process = this.#dependencies.startProcess(
        'ffmpeg',
        buildArguments(source, selectedUrl, socketPath, this.options),
        {
          maxBuffer: MAX_DIAGNOSTIC_BYTES,
          shell: false,
        },
      );
      processCompletion = process.completion.then(
        () => {
          processSettled = true;
        },
        (error: unknown) => {
          processSettled = true;
          throw error;
        },
      );
      await awaitBeforeDeadline(
        processCompletion,
        workDeadline,
        monotonicNow,
      );
      const remainingMs = Math.max(
        1,
        workDeadline - monotonicNow(),
      );
      await awaitBeforeDeadline(
        sink.confirmFrame(remainingMs),
        workDeadline,
        monotonicNow,
      );
    } catch {
      failed = true;
    } finally {
      const cleanupOperations: Promise<boolean>[] = [];
      if (process && processCompletion && !processSettled) {
        cleanupOperations.push(
          terminateAndReap(
            process,
            processCompletion,
            finalDeadline,
            Math.max(1, Math.floor(cleanupReserveMs / 2)),
            monotonicNow,
          ),
        );
      }
      const sinkToClose = sink;
      if (sinkToClose) {
        cleanupOperations.push(
          cleanupBeforeDeadline(
            () => sinkToClose.close(),
            finalDeadline,
            monotonicNow,
          ),
        );
      }
      const leaseToRevoke = lease;
      if (leaseToRevoke) {
        cleanupOperations.push(
          cleanupBeforeDeadline(
            () => this.egress.revoke(leaseToRevoke),
            finalDeadline,
            monotonicNow,
          ),
        );
      }
      if ((await Promise.all(cleanupOperations)).some((ok) => !ok)) failed = true;
    }
    if (failed) throw new LiveSourceProbeFailedError();
  }

  private async validateEndpoint(
    raw: string,
  ): Promise<{ raw: string; addresses: string[]; port: number }> {
    const addresses = new Set<string>();
    const endpoint = new URL(raw);
    const hostname = endpoint.hostname.replace(/^\[|\]$/gu, '');
    const literalFamily = isIP(hostname);
    const answers = literalFamily
      ? [{ address: canonicalAddress(hostname), family: literalFamily }]
      : await this.#dependencies.lookup(hostname);
    if (answers.length === 0) throw new LiveSourceProbeFailedError();
    for (const answer of answers) {
      const address = canonicalAddress(answer.address);
      if (!this.#cidrs.some((cidr) => contains(cidr, address))) {
        throw new LiveSourceProbeFailedError();
      }
      addresses.add(address);
    }
    if (addresses.size < 1 || addresses.size > 2) {
      throw new LiveSourceProbeFailedError();
    }
    return {
      raw,
      addresses: [...addresses],
      port: endpoint.port
        ? Number(endpoint.port)
        : endpoint.protocol === 'rtsps:'
          ? 322
          : 554,
    };
  }
}

function buildArguments(
  source: LiveSource,
  inputUrl: string,
  socketPath: string,
  options: FfmpegLiveSourceProbeOptions,
): string[] {
  const transport = source.transport === 'auto' ? 'tcp' : source.transport;
  const [filter, quality] =
    source.profile === 'eco'
      ? ['fps=10,scale=320:-2', '5']
      : source.profile === 'balanced'
        ? ['fps=15,scale=640:-2', '4']
        : ['fps=20,scale=1280:-2', '3'];
  const endpoint = new URL(inputUrl);
  const tls = source.tlsMode === 'strict'
    ? [
        '-tls_verify',
        '1',
        '-verifyhost',
        endpoint.hostname.replace(/^\[|\]$/gu, ''),
        ...(options.caFile ? ['-ca_file', options.caFile] : []),
      ]
    : [];
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-protocol_whitelist',
    PROTOCOL_WHITELIST,
    '-rtsp_transport',
    transport,
    '-min_port',
    String(options.udpPortFirst),
    '-max_port',
    String(options.udpPortLast),
    '-timeout',
    '5000000',
    ...tls,
    '-i',
    inputUrl,
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    filter,
    '-c:v',
    'mjpeg',
    '-q:v',
    quality,
    '-frames:v',
    '1',
    '-flush_packets',
    '1',
    '-f',
    'image2pipe',
    `unix://${socketPath}`,
  ];
}

async function defaultLookup(hostname: string) {
  return lookup(hostname, { all: true, verbatim: true });
}

export function startFfmpegProbeProcess(
  file: string,
  args: readonly string[],
  options: { maxBuffer: number; shell: false },
): ProbeProcessHandle {
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: LiveSourceProbeFailedError) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const child = execFile(file, [...args], options, (error) => {
    if (error) rejectCompletion(new LiveSourceProbeFailedError());
    else resolveCompletion();
  });
  return {
    completion,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

async function awaitBeforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  monotonicNow: () => number,
  onLateResolution?: (value: T) => void | Promise<void>,
): Promise<T> {
  const remainingMs = deadline - monotonicNow();
  if (remainingMs <= 0) {
    observeLateResolution(operation, onLateResolution);
    throw new LiveSourceProbeFailedError();
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new LiveSourceProbeFailedError());
    }, remainingMs);
  });
  operation.then(
    (value) => {
      if (timedOut && onLateResolution) {
        safeLateCleanup(() => onLateResolution(value));
      }
    },
    () => undefined,
  );
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function observeLateResolution<T>(
  operation: Promise<T>,
  onLateResolution?: (value: T) => void | Promise<void>,
): void {
  void operation.then(
    (value) => {
      if (onLateResolution) safeLateCleanup(() => onLateResolution(value));
    },
    () => undefined,
  );
}

function safeLateCleanup(operation: () => void | Promise<void>): void {
  void Promise.resolve()
    .then(operation)
    .catch(() => undefined);
}

async function cleanupBeforeDeadline(
  operation: () => Promise<void>,
  deadline: number,
  monotonicNow: () => number,
): Promise<boolean> {
  try {
    await awaitBeforeDeadline(
      Promise.resolve().then(operation),
      deadline,
      monotonicNow,
    );
    return true;
  } catch {
    return false;
  }
}

async function terminateAndReap(
  process: ProbeProcessHandle,
  completion: Promise<void>,
  finalDeadline: number,
  termGraceMs: number,
  monotonicNow: () => number,
): Promise<boolean> {
  try {
    process.kill('SIGTERM');
  } catch {
    // Continue to the non-catchable signal attempt below.
  }
  const termDeadline = Math.min(
    finalDeadline,
    monotonicNow() + termGraceMs,
  );
  if (await settlesBefore(completion, termDeadline, monotonicNow)) return true;
  try {
    process.kill('SIGKILL');
  } catch {
    // The final bounded reap below still observes a concurrent exit.
  }
  return settlesBefore(completion, finalDeadline, monotonicNow);
}

async function settlesBefore(
  completion: Promise<void>,
  deadline: number,
  monotonicNow: () => number,
): Promise<boolean> {
  try {
    await awaitBeforeDeadline(
      completion.then(
        () => undefined,
        () => undefined,
      ),
      deadline,
      monotonicNow,
    );
    return true;
  } catch {
    return false;
  }
}

export async function openFfmpegProbeUnixSink(
  path: string,
  dependencies: Partial<UnixSinkSetupDependencies> = {},
): Promise<UnixSink> {
  const mkdirSink = dependencies.mkdir ?? mkdir;
  const unlinkSink = dependencies.unlink ?? unlink;
  const createSinkServer =
    dependencies.createServer ??
    ((onConnection: (socket: Socket) => void) => createServer(onConnection));
  await mkdirSink(dirname(path), { recursive: true, mode: 0o700 });
  await unlinkSink(path).catch(() => undefined);
  const sockets = new Set<Socket>();
  const tracker = new BoundedJpegFrameTracker();
  let sinkFailed = false;
  let closed = false;
  const server = createSinkServer((socket) => {
    sockets.add(socket);
    socket.on('data', (chunk: Buffer) => {
      try {
        tracker.accept(chunk);
      } catch {
        sinkFailed = true;
        socket.destroy();
      }
    });
    socket.on('error', () => tracker.finish());
    socket.on('close', () => {
      sockets.delete(socket);
      tracker.finish();
    });
  });
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await unlinkSink(path).catch(() => undefined);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await (dependencies.chmod ?? chmod)(path, 0o600);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  return {
    confirmFrame: async (timeoutMs) => {
      if (sinkFailed) throw new LiveSourceProbeFailedError();
      await tracker.waitForFrame(timeoutMs);
    },
    close,
  };
}

interface ParsedCidr {
  family: 4 | 6;
  network: bigint;
  prefix: number;
}

function parseCidrs(raw: string): ParsedCidr[] {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new LiveSourceNetworkPolicyInvalidError();
  }
  const cidrs = raw.split(',').map((entry) => {
    const match = /^([^/]+)\/(\d{1,3})$/u.exec(entry.trim());
    if (!match) throw new LiveSourceNetworkPolicyInvalidError();
    const family = isIP(match[1]);
    const prefix = Number(match[2]);
    const bits = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (!bits || prefix < 8 || prefix > bits) {
      throw new LiveSourceNetworkPolicyInvalidError();
    }
    const value = addressValue(canonicalAddress(match[1]));
    const hostBits = BigInt(bits - prefix);
    const network = (value >> hostBits) << hostBits;
    if (network !== value) throw new LiveSourceNetworkPolicyInvalidError();
    return { family, network, prefix } as ParsedCidr;
  });
  return cidrs;
}

function contains(cidr: ParsedCidr, rawAddress: string): boolean {
  const family = isIP(rawAddress);
  if (family !== cidr.family) return false;
  const bits = family === 4 ? 32 : 128;
  const hostBits = BigInt(bits - cidr.prefix);
  return (addressValue(rawAddress) >> hostBits) << hostBits === cidr.network;
}

function canonicalAddress(address: string): string {
  const family = isIP(address);
  if (family === 4) return new URL(`http://${address}/`).hostname;
  if (family === 6) return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  throw new LiveSourceProbeFailedError();
}

function addressValue(address: string): bigint {
  if (isIP(address) === 4) {
    return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
  }
  const [leftRaw, rightRaw = ''] = address.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  const zeros = Array.from(
    { length: 8 - left.length - right.length },
    () => '0',
  );
  const groups: string[] = [...left, ...zeros, ...right];
  if (groups.length !== 8) throw new LiveSourceNetworkPolicyInvalidError();
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || '0'}`), 0n);
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isSafeRuntimeDirectory(value: string): boolean {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    !containsControlCharacter(value) &&
    !value.split('/').includes('..') &&
    [
      '/run/home-worker/',
      '/opt/home-worker/',
      '/tmp/',
      '/private/var/folders/',
    ].some((root) => value.startsWith(root))
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function strictInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) throw new LiveSourceNetworkPolicyInvalidError();
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new LiveSourceNetworkPolicyInvalidError();
  return value;
}
