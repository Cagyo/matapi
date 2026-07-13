import { execFile as nodeExecFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, rename, unlink, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { StreamRuntimeUnavailableError } from '../domain/errors/stream-runtime-unavailable.error';
import type {
  StreamSandboxPort,
  StreamSandboxStartResult,
} from '../domain/ports/stream-sandbox.port';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_LEASE_MS = 300_000;
const MAX_STATUS_BYTES = 65_536;

export interface SystemdFfmpegStreamOptions {
  configDirectory: string;
  outputDirectory: string;
  startupTimeoutMs: number;
  udpPortFirst?: number;
  udpPortLast?: number;
  caFile?: string;
}

interface Dependencies {
  startProcess(
    file: string,
    args: readonly string[],
    options: { shell: false; maxBuffer: number },
  ): SystemctlProcessHandle;
  /** Test-only compatibility seam; production always retains a child handle. */
  execFile?(
    file: string,
    args: readonly string[],
    options: { shell: false; timeout: number; maxBuffer: number },
  ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
  inspectSocket(path: string): Promise<unknown>;
  inspectRuntimeDirectory(path: string, mode: 0o2730 | 0o3770): Promise<unknown>;
  inspectCaFile(path: string): Promise<unknown>;
  now(): number;
  randomSuffix(): string;
}

interface SystemctlProcessHandle {
  completion: Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
  kill(signal: NodeJS.Signals): void;
}

/**
 * Starts only the fixed, UUID-instanced stream template. Polkit authorizes
 * these exact systemd operations; no sudo or shell is involved. The gateway
 * must create the private Unix listener first. The runner moves the credential
 * URL into a sealed anonymous file so it never appears in FFmpeg argv.
 */
export class SystemdFfmpegStreamAdapter implements StreamSandboxPort {
  readonly #dependencies: Dependencies;

  constructor(
    private readonly options: SystemdFfmpegStreamOptions = {
      configDirectory: '/run/home-worker/live-stream-config',
      outputDirectory: '/run/home-worker/live-stream-output',
      startupTimeoutMs: 30_000,
      udpPortFirst: 24_000,
      udpPortLast: 24_001,
    },
    dependencies: Partial<Dependencies> = {},
  ) {
    this.#dependencies = {
      startProcess: dependencies.startProcess ?? (dependencies.execFile
        ? (file, args, options) => ({
            completion: dependencies.execFile!(file, args, {
              ...options,
              timeout: this.options.startupTimeoutMs,
            }),
            kill: () => undefined,
          })
        : startSystemctlProcess),
      inspectSocket: dependencies.inspectSocket ?? inspectGatewaySocket,
      inspectRuntimeDirectory: dependencies.inspectRuntimeDirectory ?? inspectPrivateRuntimeDirectory,
      inspectCaFile: dependencies.inspectCaFile ?? validateCaFile,
      now: dependencies.now ?? Date.now,
      randomSuffix: dependencies.randomSuffix ?? (() => randomBytes(8).toString('hex')),
    };
  }

  async start(input: Parameters<StreamSandboxPort['start']>[0]): Promise<StreamSandboxStartResult> {
    let configPath: string | undefined;
    let temporaryPath: string | undefined;
    let unit: string | undefined;
    let startAttempted = false;
    try {
      const now = this.#dependencies.now();
      const sessionId = normalizeSession(input.sessionId);
      if (!Number.isSafeInteger(input.expiresAtUnixMs) || input.expiresAtUnixMs <= now || input.expiresAtUnixMs - now > MAX_LEASE_MS) {
        throw new Error('expiry');
      }
      const socketPath = `${this.options.outputDirectory}/${sessionId}.sock`;
      await this.#dependencies.inspectRuntimeDirectory(this.options.configDirectory, 0o2730);
      await this.#dependencies.inspectRuntimeDirectory(this.options.outputDirectory, 0o3770);
      await this.#dependencies.inspectSocket(socketPath);

      configPath = `${this.options.configDirectory}/${sessionId}.json`;
      temporaryPath = `${configPath}.tmp-${this.#dependencies.randomSuffix()}`;
      const payload = input.source.source.credentialPayload();
      const selectedUrl = input.source.source.profile === 'eco' && payload.substreamUrl
        ? payload.substreamUrl
        : payload.primaryUrl;
      const originalUrl = new URL(selectedUrl);
      const originalHostname = originalUrl.hostname.replace(/^\[|\]$/gu, '');
      if (!isIP(input.connectionAddress) ||
          (input.source.source.tlsMode === 'strict'
            ? input.tlsServerName !== originalHostname
            : input.tlsServerName !== null)) {
        throw new Error('connection identity');
      }
      originalUrl.hostname = isIP(input.connectionAddress) === 6
        ? `[${input.connectionAddress}]`
        : input.connectionAddress;
      if (this.options.caFile) await this.#dependencies.inspectCaFile(this.options.caFile);
      await writeFile(temporaryPath, `${JSON.stringify({
        version: 1,
        sessionId,
        inputUrl: originalUrl.toString(),
        tlsServerName: input.tlsServerName,
        transport: input.source.source.transport === 'auto' ? 'tcp' : input.source.source.transport,
        tlsMode: input.source.source.tlsMode,
        profile: input.source.source.profile,
        udpPortFirst: this.options.udpPortFirst ?? 24_000,
        udpPortLast: this.options.udpPortLast ?? 24_001,
        outputSocket: socketPath,
        expiresAtUnixMs: input.expiresAtUnixMs,
        ownerUid: typeof process.getuid === 'function' ? process.getuid() : -1,
        caFile: this.options.caFile ?? null,
      })}\n`, { mode: 0o640, flag: 'wx' });
      await chmod(temporaryPath, 0o640);
      await rename(temporaryPath, configPath);
      temporaryPath = undefined;

      unit = `homeworker-ffmpeg-stream@${sessionId}.service`;
      startAttempted = true;
      await this.runSystemctl(['start', unit]);
      const status = await this.runSystemctl(['is-active', unit]);
      if (String(status.stdout).trim() !== 'active') throw new Error('inactive');
      const identity = await this.runSystemctl([
        'show', unit,
        '--property=MainPID', '--property=ActiveEnterTimestampMonotonic', '--value',
      ]);
      const [pid, startedAt, ...extra] = String(identity.stdout).trim().split(/\s+/u);
      if (extra.length > 0 || !/^[1-9]\d*$/u.test(pid ?? '') || !/^[1-9]\d*$/u.test(startedAt ?? '')) {
        throw new Error('identity');
      }
      return {
        processIdentity: `pid:${pid}:start:${startedAt}`,
        health: { ready: true },
        output: { kind: 'unix-socket', socketPath, queueCapacityFrames: 2 },
      };
    } catch {
      if (startAttempted && unit) await this.runSystemctl(['stop', unit]).catch(() => undefined);
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
      if (configPath) await unlink(configPath).catch(() => undefined);
      throw new StreamRuntimeUnavailableError();
    }
  }

  async stop(rawSessionId: string): Promise<void> {
    let sessionId: string;
    try {
      sessionId = normalizeSession(rawSessionId);
      await this.runSystemctl(['stop', `homeworker-ffmpeg-stream@${sessionId}.service`]);
    } catch {
      throw new StreamRuntimeUnavailableError();
    } finally {
      if (UUID.test(rawSessionId)) {
        await unlink(`${this.options.configDirectory}/${rawSessionId.toLowerCase()}.json`).catch(() => undefined);
      }
    }
  }

  private runSystemctl(args: readonly string[]) {
    const process = this.#dependencies.startProcess('systemctl', ['--no-ask-password', ...args], {
      shell: false,
      maxBuffer: MAX_STATUS_BYTES,
    });
    return terminateOnDeadline(process, this.options.startupTimeoutMs);
  }
}

function startSystemctlProcess(
  file: string,
  args: readonly string[],
  options: { shell: false; maxBuffer: number },
): SystemctlProcessHandle {
  let resolve!: (value: { stdout: string | Buffer; stderr: string | Buffer }) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const child = nodeExecFile(file, [...args], options, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
  return { completion, kill: (signal) => { child.kill(signal); } };
}

async function terminateOnDeadline(
  process: SystemctlProcessHandle,
  timeoutMs: number,
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('systemctl deadline')), timeoutMs);
  });
  try {
    return await Promise.race([process.completion, timeout]);
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (!(error instanceof Error) || error.message !== 'systemctl deadline') throw error;
    try { process.kill('SIGTERM'); } catch { /* continue to SIGKILL */ }
    if (await settlesWithin(process.completion, Math.min(1_000, Math.max(50, Math.floor(timeoutMs / 4))))) {
      throw error;
    }
    try { process.kill('SIGKILL'); } catch { /* bounded reap still follows */ }
    await settlesWithin(process.completion, 1_000);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function inspectPrivateRuntimeDirectory(path: string, mode: 0o2730 | 0o3770): Promise<void> {
  const value = await lstat(path);
  const groups = typeof process.getgroups === 'function' ? process.getgroups() : [];
  if (!value.isDirectory() || value.isSymbolicLink() || (value.mode & 0o7777) !== mode ||
      typeof process.getuid !== 'function' || value.uid !== 0 || !groups.includes(value.gid)) {
    throw new Error('unsafe runtime directory');
  }
}

async function validateCaFile(path: string): Promise<void> {
  const normalized = resolve(path);
  if (normalized !== path || !['/etc/ssl/certs/', '/etc/home-worker/ca/'].some((root) => normalized.startsWith(root))) {
    throw new Error('unsafe CA path');
  }
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== 0 || (value.mode & 0o022) !== 0 || (value.mode & 0o004) === 0) {
    throw new Error('unsafe CA file');
  }
}

async function inspectGatewaySocket(path: string): Promise<void> {
  const value = await lstat(path);
  const getUid = process.getuid;
  const getGroups = process.getgroups;
  if (!value.isSocket() || (value.mode & 0o777) !== 0o660 ||
      typeof getUid !== 'function' || value.uid !== getUid() ||
      typeof getGroups !== 'function' || !getGroups().includes(value.gid)) {
    throw new Error('unsafe output socket');
  }
}

function normalizeSession(value: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('session');
  return value.toLowerCase();
}
