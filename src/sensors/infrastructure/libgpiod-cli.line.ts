// src/sensors/infrastructure/libgpiod-cli.line.ts
import { Logger } from '@nestjs/common';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { GpioBias, GpioLine } from './gpio-backend.port';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { GPIOMON_CONSUMER_PREFIX, GpiodCliSyntax } from './libgpiod-cli.syntax';

/** Mirrors PIGPIO_RECONNECT_DELAYS_MS; alarm lines never stop retrying. */
export const LINE_RESPAWN_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** A foreign consumer may release; retry forever on a slow ladder. */
export const FOREIGN_BUSY_RETRY_MS = 60_000;
/**
 * ~2× the respawn ladder cap. read() serves cache while the monitor is
 * attached or down for less than this; it throws once down longer. Keyed off
 * monitor liveness, never level age — see gpio-backend.port.ts.
 */
export const MONITOR_LIVENESS_THRESHOLD_MS = 60_000;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ATTACH_POLL_ATTEMPTS = 10;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ATTACH_POLL_INTERVAL_MS = 50;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const KILL_ESCALATION_MS = 2_000;

export type LineExecFile = (
  executable: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;
export type LineSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface LineContext {
  chip: string;
  syntax: GpiodCliSyntax;
  tools: { gpioget: string; gpiomon: string; gpioinfo: string; stdbuf: string };
  execFile: LineExecFile;
  spawn: LineSpawn;
  /** Kill orphaned monitors matching our argv signature for this offset; returns count killed. */
  sweepOrphans(offset: number): Promise<number>;
  /** Escalate chip-level failures (ENOENT/EACCES) to backend availability. */
  onChipError(error: Error): void;
  now(): number;
}

/** Config invalid — the only terminal class. */
export class GpioLineTerminalError extends Error {}
export class GpioMonitorDownError extends Error {}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type SpawnOutcome =
  | { kind: 'attached' }
  | { kind: 'stopped' }
  | { kind: 'transient' }
  | { kind: 'foreign-busy' }
  | { kind: 'terminal'; detail: string };

export class LibgpiodCliLine implements GpioLine {
  private readonly logger: Logger;
  private bias: GpioBias = 'none';
  private debounceUs = 0;
  private queue: Promise<unknown> = Promise.resolve();

  /** Modelled explicitly so a deliberate kill is never misclassified as a crash. */
  private desired: 'stopped' | 'watching' = 'stopped';
  private callback?: (level: 0 | 1) => void;
  private child?: ChildProcess;
  private incarnation = 0;
  private readonly stderrBuffers = new Map<number, string>();
  private attached = false;
  private downSince: number | null = null;
  private cachedLevel: 0 | 1 | null = null;
  private respawnTimer?: NodeJS.Timeout;
  private attempt = 0;
  private terminalError: Error | null = null;
  private foreignConsumer: string | null = null;

  constructor(
    private readonly offset: number,
    private readonly context: LineContext,
  ) {
    this.logger = new Logger(`${LibgpiodCliLine.name}:${offset}`);
  }

  configure(options: { bias: GpioBias; debounceUs: number }): Promise<void> {
    return this.enqueue(async () => {
      this.bias = options.bias;
      this.debounceUs = options.debounceUs;
      if (this.debounceUs > 0 && this.context.syntax.major === 1) {
        // Logged once and ignored: JS debounce already yields correct output
        // for sub-threshold glitches; the hardware filter was CPU protection,
        // which the circuit breaker covers.
        this.logger.log(
          `libgpiod v1 has no --debounce-period; ${this.debounceUs}µs is software-debounced only`,
        );
      }
    });
  }

  read(): Promise<0 | 1> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.desired === 'watching') {
      const live =
        this.attached ||
        (this.downSince !== null &&
          this.context.now() - this.downSince < MONITOR_LIVENESS_THRESHOLD_MS);
      if (live && this.cachedLevel !== null) return Promise.resolve(this.cachedLevel);
      return Promise.reject(
        new GpioMonitorDownError(
          `gpio ${this.offset}: monitor down past liveness threshold` +
            (this.foreignConsumer ? ` (line held by "${this.foreignConsumer}")` : ''),
        ),
      );
    }
    return this.enqueue(() => this.gpioget());
  }

  watch(onLevel: (level: 0 | 1) => void): Promise<void> {
    // Implemented in Task 5.
    return Promise.reject(new Error(`watch not implemented (offset ${this.offset}, cb ${typeof onLevel})`));
  }

  unwatch(): Promise<void> {
    // Implemented in Task 5.
    return Promise.resolve();
  }

  /** Backend shutdown hook. */
  close(): Promise<void> {
    return this.unwatch();
  }

  /** For the backend's orphan sweep: our live child must never be swept. */
  childPid(): number | undefined {
    return this.child?.pid ?? undefined;
  }

  private async gpioget(): Promise<0 | 1> {
    const args = this.context.syntax.gpiogetArgs(this.context.chip, this.offset, this.bias);
    const { stdout } = await this.context.execFile(this.context.tools.gpioget, args);
    return this.context.syntax.parseGpioget(stdout);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
