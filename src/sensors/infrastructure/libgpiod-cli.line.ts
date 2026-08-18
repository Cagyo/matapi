// src/sensors/infrastructure/libgpiod-cli.line.ts
import { Logger } from '@nestjs/common';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { GpioBias, GpioLine } from './gpio-backend.port';
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
const ATTACH_POLL_ATTEMPTS = 10;
const ATTACH_POLL_INTERVAL_MS = 50;
const KILL_ESCALATION_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

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
    return this.enqueue(async () => {
      if (this.terminalError) throw this.terminalError;
      this.callback = onLevel;
      if (this.desired === 'watching' && this.attached) return;
      this.desired = 'watching';
      this.attempt = 0;
      this.downSince ??= this.context.now();

      const outcome = await this.spawnAttempt({ pushReconcile: false });
      if (outcome.kind === 'terminal') {
        this.terminalError = new GpioLineTerminalError(outcome.detail);
        throw this.terminalError;
      }
      // Transient failures enter the ladder and still resolve —
      // resumeFromFlapping calls this as `void line.watch(...)`.
      if (outcome.kind === 'transient') this.scheduleRespawn(false);
      if (outcome.kind === 'foreign-busy') this.scheduleRespawn(true);
    });
  }

  unwatch(): Promise<void> {
    return this.enqueue(() => this.stopMonitor());
  }

  /** Backend shutdown hook. */
  close(): Promise<void> {
    return this.unwatch();
  }

  /** For the backend's orphan sweep: our live child must never be swept. */
  childPid(): number | undefined {
    return this.child?.pid ?? undefined;
  }

  private async spawnAttempt(options: { pushReconcile: boolean }): Promise<SpawnOutcome> {
    if (this.desired !== 'watching') return { kind: 'stopped' };

    // 1. Reconcile/seed read while the line is unheld — a transition during
    //    the blind window still lands.
    let level: 0 | 1;
    try {
      level = await this.gpioget();
    } catch (error) {
      return this.classifyFailure(error as Error);
    }
    this.cachedLevel = level;
    if (options.pushReconcile) this.callback?.(level);

    // 2. Spawn. stdbuf -oL because C stdio block-buffers into a pipe; an alarm
    //    path must not rest on "gpiomon probably flushes".
    const incarnation = ++this.incarnation;
    const child = this.context.spawn(
      this.context.tools.stdbuf,
      [
        '-oL',
        this.context.tools.gpiomon,
        ...this.context.syntax.gpiomonArgs(this.context.chip, this.offset, this.bias, this.debounceUs),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    this.wireChild(child, incarnation);

    // 3. Confirm attach.
    if (await this.confirmAttach(child)) {
      this.attached = true;
      this.downSince = null;
      this.attempt = 0;
      this.foreignConsumer = null;
      return { kind: 'attached' };
    }
    const stderr = (this.stderrBuffers.get(incarnation) ?? '').trim();
    this.stderrBuffers.delete(incarnation);
    await this.disposeChild(child, incarnation);
    return this.classifyFailure(new Error(stderr || 'gpiomon did not attach'));
  }

  private wireChild(child: ChildProcess, incarnation: number): void {
    let pending = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // Stale incarnations are discarded; residual buffered events from the
      // CURRENT incarnation between 'exit' and 'close' are real and processed.
      if (incarnation !== this.incarnation) return;
      pending += chunk;
      const rows = pending.split('\n');
      pending = rows.pop() ?? '';
      for (const row of rows) {
        const level = this.context.syntax.parseGpiomonEvent(row);
        if (level === null) continue;
        this.cachedLevel = level;
        this.callback?.(level);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrBuffers.set(incarnation, (this.stderrBuffers.get(incarnation) ?? '') + chunk);
    });
    child.on('error', () => undefined); // surfaced via attach/exit classification
    child.on('exit', () => {
      if (incarnation !== this.incarnation || this.desired !== 'watching') return;
      this.attached = false;
      this.downSince = this.context.now();
      // Wait for the stdout stream to flush and close before scheduling the
      // reconcile read, so stale buffered edges can never land after it.
      const stream = child.stdout;
      const proceed = () => {
        if (incarnation !== this.incarnation || this.desired !== 'watching') return;
        this.incarnation += 1; // retire: later 'data' from this stream is discarded
        this.stderrBuffers.delete(incarnation);
        this.logger.warn(`gpiomon for offset ${this.offset} exited; scheduling respawn`);
        this.scheduleRespawn(false);
      };
      if (stream && !stream.destroyed) stream.once('close', proceed);
      else proceed();
    });
  }

  private async confirmAttach(child: ChildProcess): Promise<boolean> {
    const expectedConsumer =
      this.context.syntax.major === 2 ? `${GPIOMON_CONSUMER_PREFIX}${this.offset}` : null;
    for (let poll = 0; poll < ATTACH_POLL_ATTEMPTS; poll += 1) {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      try {
        const { stdout } = await this.context.execFile(
          this.context.tools.gpioinfo,
          this.context.syntax.gpioinfoArgs(this.context.chip),
        );
        const consumer = this.context.syntax.consumerOf(stdout, this.offset);
        if (consumer !== null) {
          if (expectedConsumer !== null && consumer !== expectedConsumer) {
            // v2: unambiguous foreign holder — our child will die EBUSY.
            this.foreignConsumer = consumer;
            return false;
          }
          // v1: consumer is the fixed "gpiomon"; attach = consumer present AND
          // our child alive (checked at loop top and again here).
          if (child.exitCode === null && child.signalCode === null) return true;
        }
      } catch {
        // gpioinfo hiccup — keep polling within the bounded window.
      }
      await delay(ATTACH_POLL_INTERVAL_MS);
    }
    return false;
  }

  private async stopMonitor(): Promise<void> {
    this.desired = 'stopped';
    this.callback = undefined;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    this.attached = false;
    this.downSince = null;
    this.attempt = 0;
    this.incarnation += 1; // exit handler sees a stale incarnation: no respawn
    if (child?.exitCode !== null || child?.signalCode !== null) return;
    await this.killChild(child);
  }

  private killChild(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolveKill) => {
      const escalation = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_ESCALATION_MS);
      escalation.unref();
      child.once('exit', () => {
        clearTimeout(escalation);
        resolveKill();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(escalation);
        resolveKill();
      }
    });
  }

  private async disposeChild(child: ChildProcess, incarnation: number): Promise<void> {
    if (this.child === child) this.child = undefined;
    if (incarnation === this.incarnation) this.incarnation += 1;
    if (child.exitCode === null && child.signalCode === null) await this.killChild(child);
  }

  private scheduleRespawn(foreignBusy: boolean): void {
    // Full ladder — Task 6's tests prove the reconcile/stale-discard ordering.
    if (this.desired !== 'watching' || this.respawnTimer || this.terminalError) return;
    const delayMs = foreignBusy
      ? FOREIGN_BUSY_RETRY_MS
      : LINE_RESPAWN_DELAYS_MS[Math.min(this.attempt, LINE_RESPAWN_DELAYS_MS.length - 1)];
    this.attempt += 1;
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = undefined;
      void this.enqueue(async () => {
        if (this.desired !== 'watching' || this.attached) return;
        const outcome = await this.spawnAttempt({ pushReconcile: true });
        if (outcome.kind === 'terminal') {
          this.terminalError = new GpioLineTerminalError(outcome.detail);
          this.logger.error(outcome.detail);
          return;
        }
        if (outcome.kind === 'transient') this.scheduleRespawn(false);
        if (outcome.kind === 'foreign-busy') this.scheduleRespawn(true);
      });
    }, delayMs);
    this.respawnTimer.unref();
  }

  private async classifyFailure(error: Error): Promise<SpawnOutcome> {
    const message = error.message;

    if (/EBUSY|resource busy/iu.test(message)) {
      const swept = await this.context.sweepOrphans(this.offset).catch(() => 0);
      if (swept > 0) {
        this.logger.warn(`gpio ${this.offset}: EBUSY from our own orphan; swept ${swept}, retrying`);
        return { kind: 'transient' };
      }
      // A failure class pigpiod's shared model hid entirely: another gpiomon,
      // a dtoverlay, gpiozero. The name must reach the operator.
      this.foreignConsumer = await this.currentConsumer();
      this.logger.warn(
        `gpio ${this.offset}: line held by foreign consumer "${this.foreignConsumer ?? 'unknown'}"; retrying every ${FOREIGN_BUSY_RETRY_MS / 1000}s`,
      );
      return { kind: 'foreign-busy' };
    }

    if (/ENOENT|EACCES|No such file|Permission denied/u.test(message)) {
      this.context.onChipError(error);
      return { kind: 'transient' }; // backend availability machinery owns recovery
    }

    if (/invalid|unrecognized option|bad argument/iu.test(message)) {
      return { kind: 'terminal', detail: `gpio ${this.offset}: ${message}` };
    }

    this.logger.warn(`gpio ${this.offset}: transient failure: ${message}`);
    return { kind: 'transient' };
  }

  private async currentConsumer(): Promise<string | null> {
    try {
      const { stdout } = await this.context.execFile(
        this.context.tools.gpioinfo,
        this.context.syntax.gpioinfoArgs(this.context.chip),
      );
      return this.context.syntax.consumerOf(stdout, this.offset);
    } catch {
      return null;
    }
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
