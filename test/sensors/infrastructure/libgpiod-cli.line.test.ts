// test/sensors/infrastructure/libgpiod-cli.line.test.ts
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LibgpiodCliLine,
  LineContext,
  GpioMonitorDownError,
  GpioLineTerminalError,
  MONITOR_LIVENESS_THRESHOLD_MS,
} from '../../../src/sensors/infrastructure/libgpiod-cli.line';
import { syntaxFor } from '../../../src/sensors/infrastructure/libgpiod-cli.syntax';

class FakeStream extends EventEmitter {
  destroyed = false;
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signalsSent: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalsSent.push(signal);
    this.exit(0, signal);
    return true;
  }

  emitEvent(line: string): void {
    this.stdout.emit('data', `${line}\n`);
  }

  /** Exit, then flush late buffered lines, then close — the stale-stdout ordering hazard. */
  exitFlushingLater(code: number, lateLines: string[]): void {
    this.exitCode = code;
    this.emit('exit', code, null);
    for (const line of lateLines) this.stdout.emit('data', `${line}\n`);
    this.stdout.destroyed = true;
    this.stdout.emit('close');
  }

  exit(code: number, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = signal ? null : code;
    this.signalCode = signal;
    this.emit('exit', signal ? null : code, signal);
    this.stdout.destroyed = true;
    this.stdout.emit('close');
  }
}

const V1_INFO_HELD = [
  'gpiochip0 - 54 lines:',
  '\tline   0:      "ID_SDA"       unused   input  active-high',
  '\tline  17:      "GPIO17"    "gpiomon"   input  active-high [used]',
  '',
].join('\n');
const V1_INFO_FREE = V1_INFO_HELD.replace('"gpiomon"', '  unused ').replace(' [used]', '');

interface Harness {
  line: LibgpiodCliLine;
  context: LineContext;
  spawned: FakeChild[];
  execFile: ReturnType<typeof vi.fn>;
  sweepOrphans: ReturnType<typeof vi.fn>;
  onChipError: ReturnType<typeof vi.fn>;
  gpiogetResults: ({ stdout: string } | Error)[];
  gpioinfoStdout: { value: string };
}

function makeHarness(overrides: Partial<LineContext> = {}): Harness {
  const spawned: FakeChild[] = [];
  const gpiogetResults: ({ stdout: string } | Error)[] = [];
  const gpioinfoStdout = { value: V1_INFO_HELD };
  const sweepOrphans = vi.fn(async () => 0);
  const onChipError = vi.fn();
  const execFile = vi.fn(async (executable: string) => {
    if (executable.endsWith('gpioget')) {
      const next = gpiogetResults.shift() ?? { stdout: '1\n' };
      if (next instanceof Error) throw next;
      return { stdout: next.stdout, stderr: '' };
    }
    if (executable.endsWith('gpioinfo')) return { stdout: gpioinfoStdout.value, stderr: '' };
    return { stdout: '', stderr: '' };
  });
  const context: LineContext = {
    chip: 'gpiochip0',
    syntax: syntaxFor(1),
    tools: {
      gpioget: '/usr/bin/gpioget',
      gpiomon: '/usr/bin/gpiomon',
      gpioinfo: '/usr/bin/gpioinfo',
      stdbuf: '/usr/bin/stdbuf',
    },
    execFile,
    spawn: vi.fn(() => {
      const child = new FakeChild();
      spawned.push(child);
      return child as unknown as ChildProcess;
    }),
    sweepOrphans,
    onChipError,
    now: () => Date.now(),
    ...overrides,
  };
  return {
    line: new LibgpiodCliLine(17, context),
    context,
    spawned,
    execFile,
    sweepOrphans,
    onChipError,
    gpiogetResults,
    gpioinfoStdout,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LibgpiodCliLine — configure and unmonitored read', () => {
  it('reads via a real gpioget with the configured bias when unmonitored', async () => {
    const { line, execFile, gpiogetResults } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 10_000 });
    gpiogetResults.push({ stdout: '0\n' });

    await expect(line.read()).resolves.toBe(0);

    expect(execFile).toHaveBeenCalledWith('/usr/bin/gpioget', ['--bias=pull-up', 'gpiochip0', '17']);
  });

  it('serializes queued operations in order', async () => {
    const order: string[] = [];
    const { line } = makeHarness({
      execFile: vi.fn(async (executable: string) => {
        order.push(executable.split('/').pop()!);
        await new Promise((resolveDelay) => setImmediate(resolveDelay));
        return { stdout: '1\n', stderr: '' };
      }),
    });
    await Promise.all([
      line.configure({ bias: 'down', debounceUs: 0 }),
      line.read(),
      line.read(),
    ]);
    expect(order).toEqual(['gpioget', 'gpioget']);
  });

  it('propagates gpioget failures to the unmonitored reader', async () => {
    const { line, gpiogetResults } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    gpiogetResults.push(new Error('boom'));
    await expect(line.read()).rejects.toThrow('boom');
  });
});

describe('LibgpiodCliLine — watch/attach/events/unwatch', () => {
  it('spawns stdbuf -oL gpiomon and confirms attach via gpioinfo consumer + live child', async () => {
    const { line, context, spawned } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    const levels: (0 | 1)[] = [];

    await line.watch((level) => levels.push(level));

    expect(context.spawn).toHaveBeenCalledWith(
      '/usr/bin/stdbuf',
      ['-oL', '/usr/bin/gpiomon', '--bias=pull-up', '--format=%e', 'gpiochip0', '17'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(spawned).toHaveLength(1);
    // No synthesized initial level on an immediately-attached first watch.
    expect(levels).toEqual([]);
  });

  it('delivers parsed event levels through the watch callback and serves them from cache', async () => {
    const { line, spawned } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    const levels: (0 | 1)[] = [];
    await line.watch((level) => levels.push(level));

    spawned[0].emitEvent('0');
    spawned[0].emitEvent('1');
    spawned[0].emitEvent('not-an-event');

    expect(levels).toEqual([0, 1]);
    await expect(line.read()).resolves.toBe(1); // cached, no gpioget while monitored
  });

  it('unwatch kills the monitor and never respawns a deliberate kill', async () => {
    vi.useFakeTimers();
    const { line, spawned, context } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    await line.watch(() => undefined);

    await line.unwatch();

    expect(spawned[0].signalsSent).toContain('SIGTERM');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(context.spawn).toHaveBeenCalledTimes(1); // no respawn after the kill
  });

  it('read() after unwatch is a real gpioget again (poll queues behind the kill)', async () => {
    const { line, gpiogetResults, execFile } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    await line.watch(() => undefined);
    await line.unwatch();
    gpiogetResults.push({ stdout: '0\n' });

    await expect(line.read()).resolves.toBe(0);
    // seed read at watch + this one
    expect(execFile.mock.calls.filter(([exe]) => exe.endsWith('gpioget'))).toHaveLength(2);
  });
});

describe('LibgpiodCliLine — respawn and reconciliation', () => {
  it('respawns a crashed monitor on the ladder and pushes the reconcile level', async () => {
    vi.useFakeTimers();
    const { line, spawned, gpiogetResults, context } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    const levels: (0 | 1)[] = [];
    await line.watch((level) => levels.push(level));

    gpiogetResults.push({ stdout: '0\n' }); // level changed during the blind window
    spawned[0].exit(1); // crash
    await vi.advanceTimersByTimeAsync(1_000); // first ladder rung

    expect(context.spawn).toHaveBeenCalledTimes(2);
    expect(levels).toEqual([0]); // reconcile push — the blind-window transition lands
    await expect(line.read()).resolves.toBe(0);
  });

  it('discards stale buffered stdout from a dead incarnation after the reconcile push', async () => {
    vi.useFakeTimers();
    const { line, spawned, gpiogetResults } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    const levels: (0 | 1)[] = [];
    await line.watch((level) => levels.push(level));

    gpiogetResults.push({ stdout: '1\n' }); // reconcile says: high
    // The dying monitor flushes a stale "0" edge between exit and close. It is
    // buffered pre-exit output of the dead incarnation's stream — it must be
    // processed BEFORE the reconcile (close precedes the reconcile read), and
    // anything after close must be discarded.
    spawned[0].exitFlushingLater(1, ['0']);
    await vi.advanceTimersByTimeAsync(1_000);

    // Late line arrived before close → processed (0), then reconcile push (1).
    // Nothing from the dead stream lands after the reconcile.
    expect(levels).toEqual([0, 1]);
    spawned[0].emitEvent('0'); // stream events after close: dead incarnation
    expect(levels).toEqual([0, 1]);
    await expect(line.read()).resolves.toBe(1);
  });

  it('walks the capped ladder indefinitely — alarm lines never stop retrying', async () => {
    vi.useFakeTimers();
    const { line, spawned, context, gpioinfoStdout } = makeHarness();
    gpioinfoStdout.value = V1_INFO_FREE; // attach never confirms
    await line.configure({ bias: 'up', debounceUs: 0 });
    // Attach polls (10 × 50 ms) run inside watch(); under fake timers they must
    // be advanced while watch is pending, or the await deadlocks.
    const watchPromise = line.watch(() => undefined);
    await vi.advanceTimersByTimeAsync(600); // first attempt's attach-poll window
    await watchPromise;
    // watch resolved into the ladder (transient) — not attached, not rejected.

    for (const rung of [1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000]) {
      const before = (context.spawn as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(rung + 500 /* attach poll window */);
      expect((context.spawn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1);
    }
    expect(spawned.length).toBeGreaterThanOrEqual(8);
  });
});

describe('LibgpiodCliLine — failure classification and liveness', () => {
  it('EBUSY with a sweepable orphan is transient: sweep, then retry rung 1', async () => {
    vi.useFakeTimers();
    const { line, sweepOrphans, gpiogetResults, context } = makeHarness();
    sweepOrphans.mockResolvedValueOnce(1); // sweep found and killed our orphan
    await line.configure({ bias: 'up', debounceUs: 0 });
    gpiogetResults.push(new Error('gpioget: error reading GPIO: Device or resource busy'));

    await line.watch(() => undefined); // resolves into the ladder

    expect(sweepOrphans).toHaveBeenCalledWith(17);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(context.spawn).toHaveBeenCalledTimes(1); // retry spawned after the sweep
  });

  it('EBUSY with a foreign consumer retries on the slow ladder and names the holder', async () => {
    vi.useFakeTimers();
    const { line, gpiogetResults, gpioinfoStdout, context, sweepOrphans } = makeHarness();
    sweepOrphans.mockResolvedValue(0); // nothing of ours to sweep
    gpioinfoStdout.value = V1_INFO_HELD; // a foreign process holds line 17
    await line.configure({ bias: 'up', debounceUs: 0 });
    gpiogetResults.push(new Error('Device or resource busy'));

    await line.watch(() => undefined);

    // Fast ladder must NOT fire; slow ladder must.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(context.spawn).not.toHaveBeenCalled();
    gpiogetResults.push(new Error('Device or resource busy'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect((context.execFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([exe]) => (exe as string).endsWith('gpioget'),
    ).length).toBe(2);

    // The holder's name reaches the operator through read()'s failure...
    // FOREIGN_BUSY_RETRY_MS === MONITOR_LIVENESS_THRESHOLD_MS (both 60s), so
    // this advance lands exactly on the next scheduled retry; the foreign
    // consumer is still holding the line, so its gpioget still fails too.
    gpiogetResults.push(new Error('Device or resource busy'));
    await vi.advanceTimersByTimeAsync(MONITOR_LIVENESS_THRESHOLD_MS);
    await expect(line.read()).rejects.toThrow(/held by "gpiomon"/);
  });

  it('escalates ENOENT/EACCES on the chip to the backend and keeps retrying quietly', async () => {
    vi.useFakeTimers();
    const { line, gpiogetResults, onChipError } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    gpiogetResults.push(new Error('gpioget: cannot open /dev/gpiochip0: Permission denied'));

    await line.watch(() => undefined);

    expect(onChipError).toHaveBeenCalledTimes(1);
  });

  it('config-invalid is terminal: watch rejects and read rethrows', async () => {
    const { line, gpiogetResults } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    gpiogetResults.push(new Error('gpioget: invalid bias: pull-sideways'));

    await expect(line.watch(() => undefined)).rejects.toThrow(GpioLineTerminalError);
    await expect(line.read()).rejects.toThrow(GpioLineTerminalError);
  });

  it('a quiet but healthy monitor serves cache indefinitely (liveness, not level age)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { line } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    await line.watch(() => undefined); // seed read = 1, then silence

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // a silent day
    await expect(line.read()).resolves.toBe(1);
  });

  it('a downed monitor serves cache inside the threshold and throws past it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { line, spawned, gpiogetResults, gpioinfoStdout } = makeHarness();
    await line.configure({ bias: 'up', debounceUs: 0 });
    await line.watch(() => undefined);

    gpioinfoStdout.value = V1_INFO_FREE; // respawns can no longer attach
    gpiogetResults.push(new Error('Device or resource busy')); // reconcile fails too
    spawned[0].exit(1);
    await vi.advanceTimersByTimeAsync(1_000); // enter the ladder, still down

    await expect(line.read()).resolves.toBe(1); // inside threshold: cache
    await vi.advanceTimersByTimeAsync(MONITOR_LIVENESS_THRESHOLD_MS);
    await expect(line.read()).rejects.toThrow(GpioMonitorDownError);
  });
});
