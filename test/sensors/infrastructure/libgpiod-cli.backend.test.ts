// test/sensors/infrastructure/libgpiod-cli.backend.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LibgpiodCliBackend,
  LibgpiodCliSeams,
} from '../../../src/sensors/infrastructure/libgpiod-cli.backend';

const V1_DETECT = 'gpiochip0 [pinctrl-bcm2835] (54 lines)\n';
const V2_DETECT = 'gpiochip0 [pinctrl-rp1] (54 lines)\ngpiochip10 [gpio-brcmstb@107d508500] (32 lines)\n';

function makeSeams(overrides: {
  version?: string;
  detect?: string;
  gpioinfoFails?: boolean;
  whichFails?: boolean;
  processes?: string;
} = {}) {
  const killed: [number, NodeJS.Signals | 0][] = [];
  const execFile = vi.fn(async (executable: string, args: readonly string[]) => {
    if (executable === '/usr/bin/which') {
      if (overrides.whichFails) throw new Error('which: not found');
      return { stdout: `/usr/bin/${args[0]}\n`, stderr: '' };
    }
    if (executable.endsWith('gpiodetect')) {
      if (args[0] === '--version') {
        return { stdout: overrides.version ?? 'gpiodetect (libgpiod) v1.6.3\n', stderr: '' };
      }
      return { stdout: overrides.detect ?? V1_DETECT, stderr: '' };
    }
    if (executable.endsWith('gpioinfo')) {
      if (overrides.gpioinfoFails) throw new Error('gpioinfo: Permission denied');
      return { stdout: 'gpiochip0 - 54 lines:\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
  const seams: LibgpiodCliSeams = {
    execFile,
    spawn: vi.fn(),
    listProcesses: vi.fn(async () => overrides.processes ?? ''),
    killProcess: vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      killed.push([pid, signal]);
      if (signal === 0) throw new Error('ESRCH'); // already gone by verify time
    }),
  };
  return { seams, execFile, killed };
}

describe('LibgpiodCliBackend', () => {
  beforeEach(() => {
    delete process.env.GPIO_CHIP;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.GPIO_CHIP;
  });

  it('connects: tools, version once, chip by label, permission probe, sweep', async () => {
    const { seams, execFile } = makeSeams();
    const backend = new LibgpiodCliBackend(seams);

    await backend.connect();

    expect(backend.isAvailable()).toBe(true);
    expect(backend.state()).toEqual({ available: true, generation: 1 });
    const versionCalls = execFile.mock.calls.filter(([, args]) => args[0] === '--version');
    expect(versionCalls).toHaveLength(1); // never sniffed per invocation
    expect(seams.listProcesses).toHaveBeenCalledTimes(1); // startup sweep ran
    await backend.close();
  });

  it('resolves the RP1 chip on a Pi 5 and honours GPIO_CHIP override', async () => {
    process.env.GPIO_CHIP = 'gpiochip10';
    const { seams } = makeSeams({ version: 'gpiodetect (libgpiod) v2.1.3\n', detect: V2_DETECT });
    const backend = new LibgpiodCliBackend(seams);
    await backend.connect();
    // The permission probe must hit the overridden chip.
    const gpioinfoCall = (seams.execFile as ReturnType<typeof vi.fn>).mock.calls.find(([exe]) =>
      (exe as string).endsWith('gpioinfo'),
    );
    expect(gpioinfoCall?.[1]).toEqual(['--chip', 'gpiochip10']);
    await backend.close();
  });

  it('rejects connect and schedules retry when the permission probe fails', async () => {
    vi.useFakeTimers();
    const { seams } = makeSeams({ gpioinfoFails: true });
    const backend = new LibgpiodCliBackend(seams);

    await expect(backend.connect()).rejects.toThrow(/Permission denied/);
    expect(backend.isAvailable()).toBe(false);
    expect(backend.state().generation).toBe(0);
    await backend.close();
  });

  it('sweeps orphaned monitors by full argv signature, sparing our own children', async () => {
    const processes = [
      '  310 /usr/bin/gpiomon --bias=pull-up --format=%e gpiochip0 17',
      '  311 /usr/bin/gpiomon gpiochip0 22', // admin's manual gpiomon: no pinned format → spared
      '  312 bash -c sleep 999',
    ].join('\n');
    const { seams, killed } = makeSeams({ processes });
    const backend = new LibgpiodCliBackend(seams);

    await backend.connect();

    expect(killed.map(([pid]) => pid)).toContain(310);
    expect(killed.map(([pid]) => pid)).not.toContain(311);
    expect(killed.map(([pid]) => pid)).not.toContain(312);
    await backend.close();
  });

  it('returns a canonical per-offset line singleton', async () => {
    const { seams } = makeSeams();
    const backend = new LibgpiodCliBackend(seams);
    await backend.connect();
    expect(backend.line(17)).toBe(backend.line(17));
    expect(backend.line(17)).not.toBe(backend.line(18));
    await backend.close();
  });

  it('drops available on chip error and bumps generation on recovery', async () => {
    vi.useFakeTimers();
    const seamState = makeSeams();
    const backend = new LibgpiodCliBackend(seamState.seams);
    await backend.connect();
    const states: { available: boolean; generation: number }[] = [];
    backend.onStateChange((state) => states.push({ ...state }));

    backend.handleChipError(new Error('EACCES: gpio group lost'));
    expect(backend.isAvailable()).toBe(false);
    expect(states).toEqual([{ available: false, generation: 1 }]);

    await vi.advanceTimersByTimeAsync(1_000); // retry ladder rung 1 reconnects
    expect(backend.isAvailable()).toBe(true);
    expect(states.at(-1)).toEqual({ available: true, generation: 2 });
    await backend.close();
  });
});
