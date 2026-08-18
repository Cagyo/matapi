// test/sensors/infrastructure/libgpiod-cli.line.test.ts
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LibgpiodCliLine,
  LineContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  GpioMonitorDownError,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  GpioLineTerminalError,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
