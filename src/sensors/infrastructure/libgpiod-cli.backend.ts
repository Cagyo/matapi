// src/sensors/infrastructure/libgpiod-cli.backend.ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GpioBackendPort,
  GpioBackendState,
  GpioLine,
} from './gpio-backend.port';
import {
  LibgpiodCliLine,
  LineContext,
  LineExecFile,
  LineSpawn,
} from './libgpiod-cli.line';
import {
  detectMajor,
  GpiodCliSyntax,
  parseGpiodetect,
  resolveChip,
  syntaxFor,
} from './libgpiod-cli.syntax';

export const LIBGPIOD_CLI_SEAMS = Symbol('LIBGPIOD_CLI_SEAMS');

/** Same shape as PIGPIO_RECONNECT_DELAYS_MS — the adapter's generation machinery carries over unchanged. */
const CONNECT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const SANITIZED_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const EXEC_OPTIONS = { env: { PATH: SANITIZED_PATH }, timeout: 5_000, maxBuffer: 64 * 1024 };
const TOOL_NAMES = ['gpiodetect', 'gpioinfo', 'gpioget', 'gpiomon', 'stdbuf'] as const;
const SWEEP_VERIFY_DELAY_MS = 500;

export interface LibgpiodCliSeams {
  execFile?: LineExecFile;
  spawn?: LineSpawn;
  /** `ps -eo pid=,args=` equivalent. */
  listProcesses?: () => Promise<string>;
  killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

const promisifiedExecFile = promisify(nodeExecFile);
const defaultExecFile: LineExecFile = async (executable, args) => {
  const { stdout, stderr } = await promisifiedExecFile(executable, [...args], EXEC_OPTIONS);
  return { stdout: String(stdout), stderr: String(stderr) };
};
const defaultSpawn: LineSpawn = (executable, args, options) =>
  nodeSpawn(executable, [...args], { ...options, env: { PATH: SANITIZED_PATH } });
const defaultListProcesses = async (): Promise<string> => {
  const { stdout } = await defaultExecFile('/bin/ps', ['-eo', 'pid=,args=']);
  return stdout;
};

/**
 * GPIO backend over the libgpiod CLI tools as supervised subprocesses.
 * One gpiomon per sensor (per-line request config, per-line circuit breaking,
 * kill-one/spawn-one dynamics). See the design doc for the EBUSY model.
 */
@Injectable()
export class LibgpiodCliBackend implements GpioBackendPort {
  private readonly logger = new Logger(LibgpiodCliBackend.name);
  private readonly execFile: LineExecFile;
  private readonly spawn: LineSpawn;
  private readonly listProcesses: () => Promise<string>;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals | 0) => void;

  private available = false;
  private generation = 0;
  private destroyed = false;
  private connectPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private closePromise: Promise<void> | null = null;

  private syntax?: GpiodCliSyntax;
  private chip?: string;
  private readonly tools = new Map<string, string>();
  private readonly lines = new Map<number, LibgpiodCliLine>();
  private readonly stateListeners = new Set<(state: GpioBackendState) => void>();

  constructor(
    @Optional() @Inject(LIBGPIOD_CLI_SEAMS) seams: LibgpiodCliSeams = {},
  ) {
    this.execFile = seams.execFile ?? defaultExecFile;
    this.spawn = seams.spawn ?? defaultSpawn;
    this.listProcesses = seams.listProcesses ?? defaultListProcesses;
    this.killProcess = seams.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  }

  connect(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('gpio backend destroyed'));
    if (this.available) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.probe()
      .then(() => {
        this.connectPromise = null;
        this.becomeAvailable();
      })
      .catch((error: Error) => {
        this.connectPromise = null;
        this.scheduleRetry();
        throw error;
      });
    return this.connectPromise;
  }

  isAvailable(): boolean {
    return this.available;
  }

  state(): GpioBackendState {
    return { available: this.available, generation: this.generation };
  }

  onStateChange(listener: (state: GpioBackendState) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  line(pin: number): GpioLine {
    let line = this.lines.get(pin);
    if (!line) {
      line = new LibgpiodCliLine(pin, this.lineContext());
      this.lines.set(pin, line);
    }
    return line;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeAll();
    return this.closePromise;
  }

  /** Per-line chip failures (ENOENT/EACCES) escalate here; per-line failures never poison backend state. */
  handleChipError(error: Error): void {
    if (this.destroyed || !this.available) return;
    this.logger.warn(`GPIO backend unavailable: ${error.message}`);
    this.available = false;
    this.publishState();
    this.scheduleRetry();
  }

  /**
   * Correctness, not optimization: shutdown-budget overruns leak children by
   * design, PM2 SIGKILL leaks them, and a monitor on a quiet alarm line never
   * hits EPIPE. Identification is by full argv signature; PPID heuristics are
   * deliberately not used. Accepted edge: a second hand-started worker would
   * sweep the running instance's live monitors — PM2 instances=1 makes that a
   * misuse scenario. Do not "fix" this into a PPID heuristic.
   */
  async sweepOrphans(offset?: number): Promise<number> {
    const syntax = this.syntax;
    const chip = this.chip;
    if (!syntax || !chip) return 0;
    const stdout = await this.listProcesses();
    const ownPids = new Set<number>();
    for (const line of this.lines.values()) {
      const pid = line.childPid();
      if (pid !== undefined) ownPids.add(pid);
    }
    let swept = 0;
    for (const row of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(row);
      if (!match) continue;
      const pid = Number(match[1]);
      if (ownPids.has(pid)) continue;
      if (!syntax.isOurMonitorArgv(match[2], chip, offset)) continue;
      this.terminate(pid);
      swept += 1;
    }
    if (swept > 0) {
      this.logger.warn(`swept ${swept} orphaned gpiomon process(es)${offset === undefined ? '' : ` for offset ${offset}`}`);
    }
    return swept;
  }

  private async probe(): Promise<void> {
    for (const tool of TOOL_NAMES) {
      const { stdout } = await this.execFile('/usr/bin/which', [tool]);
      const path = stdout.trim();
      if (!path) throw new Error(`${tool} not found on sanitized PATH`);
      this.tools.set(tool, path);
    }
    const gpiodetect = this.tool('gpiodetect');
    const version = await this.execFile(gpiodetect, ['--version']);
    this.syntax = syntaxFor(detectMajor(version.stdout));
    const detect = await this.execFile(gpiodetect, []);
    this.chip = resolveChip(parseGpiodetect(detect.stdout), process.env.GPIO_CHIP).name;
    // Proves the EFFECTIVE permissions of the running process, not merely that
    // a device node exists.
    await this.execFile(this.tool('gpioinfo'), this.syntax.gpioinfoArgs(this.chip));
    await this.sweepOrphans();
  }

  private becomeAvailable(): void {
    if (this.destroyed) return;
    this.available = true;
    this.generation += 1;
    this.retryAttempt = 0;
    this.clearRetryTimer();
    this.publishState();
    this.logger.log(
      `GPIO backend ready: ${this.chip} via libgpiod v${this.syntax?.major} CLI (generation ${this.generation})`,
    );
  }

  private scheduleRetry(): void {
    if (this.destroyed || this.available || this.retryTimer) return;
    const delayMs =
      CONNECT_RETRY_DELAYS_MS[Math.min(this.retryAttempt, CONNECT_RETRY_DELAYS_MS.length - 1)];
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.destroyed || this.available) return;
      void this.connect().catch(() => undefined);
    }, delayMs);
    this.retryTimer.unref();
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private publishState(): void {
    const state = this.state();
    for (const listener of this.stateListeners) listener(state);
  }

  private terminate(pid: number): void {
    try {
      this.killProcess(pid, 'SIGTERM');
    } catch {
      return; // already gone
    }
    const escalation = setTimeout(() => {
      try {
        this.killProcess(pid, 0); // throws ESRCH when the SIGTERM landed
        this.killProcess(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, SWEEP_VERIFY_DELAY_MS);
    escalation.unref();
  }

  private tool(name: string): string {
    const path = this.tools.get(name);
    if (!path) throw new Error(`${name} path not resolved; connect() first`);
    return path;
  }

  private lineContext(): LineContext {
    // The getters below are object-literal accessor methods: their own
    // `this` binds to the returned object, not to this backend instance, and
    // chip/syntax/tools must stay live (read fresh on each access) rather
    // than frozen at line() call time — hence the alias.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const backend = this;
    return {
      get chip(): string {
        if (!backend.chip) throw new Error('gpio chip not resolved; connect() first');
        return backend.chip;
      },
      get syntax(): GpiodCliSyntax {
        if (!backend.syntax) throw new Error('libgpiod version not detected; connect() first');
        return backend.syntax;
      },
      get tools() {
        return {
          gpioget: backend.tool('gpioget'),
          gpiomon: backend.tool('gpiomon'),
          gpioinfo: backend.tool('gpioinfo'),
          stdbuf: backend.tool('stdbuf'),
        };
      },
      execFile: (executable, args) => backend.execFile(executable, args),
      spawn: (executable, args, options) => backend.spawn(executable, args, options),
      sweepOrphans: (offset) => backend.sweepOrphans(offset),
      onChipError: (error) => backend.handleChipError(error),
      now: () => Date.now(),
    };
  }

  private async closeAll(): Promise<void> {
    this.destroyed = true;
    this.clearRetryTimer();
    this.available = false;
    this.stateListeners.clear();
    // Kills all children and clears all timers; every line timer is unref'd so
    // a hung kill cannot block process exit.
    await Promise.allSettled([...this.lines.values()].map((line) => line.close()));
    this.lines.clear();
  }
}
