import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RtspSourceStartGate } from '../../../src/camera/application/rtsp-source-start-gate.service';
import { LiveStreamUnavailableError } from '../../../src/camera/domain/errors/live-stream-unavailable.error';

describe('RtspSourceStartGate DI metadata', () => {
  it('does not expose an unbound constructor dependency', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'home-worker-gate-di-'));

    try {
      execFileSync(
        process.execPath,
        [
          require.resolve('typescript/bin/tsc'),
          '--project',
          resolve('tsconfig.json'),
          '--outDir',
          outputDir,
          '--incremental',
          'false',
        ],
        { stdio: 'pipe' },
      );

      const compiled = readFileSync(
        join(outputDir, 'camera/application/rtsp-source-start-gate.service.js'),
        'utf8',
      );

      expect(compiled).toContain('__param(1, (0, common_1.Optional)())');
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  });
});

describe('RtspSourceStartGate mutation epochs', () => {
  it('keeps the epoch stable across redundant reads', () => {
    const gate = new RtspSourceStartGate(undefined, true);

    const first = gate.snapshot();

    expect(gate.snapshot()).toBe(first);
    expect(() => gate.assertEpoch(first)).not.toThrow();
  });

  it('invalidates a snapshot taken before RTSP closed', () => {
    const gate = new RtspSourceStartGate(undefined, true);
    const epoch = gate.snapshot();

    gate.close();

    expect(() => gate.assertEpoch(epoch)).toThrow(LiveStreamUnavailableError);
  });

  it('fences a mutation whose snapshot was taken while RTSP was already closed', async () => {
    const gate = new RtspSourceStartGate();
    expect(gate.isOpen()).toBe(false);

    // The epoch never moves here, so a change-detector alone would pass.
    expect(() => gate.assertEpoch(gate.snapshot())).toThrow(LiveStreamUnavailableError);

    await gate.open();

    expect(() => gate.assertEpoch(gate.snapshot())).not.toThrow();
  });

  it('keeps an old snapshot invalid after RTSP closes and reopens', async () => {
    const gate = new RtspSourceStartGate(undefined, true);
    const epoch = gate.snapshot();

    gate.close();
    await gate.open();

    expect(gate.isOpen()).toBe(true);
    expect(() => gate.assertEpoch(epoch)).toThrow(LiveStreamUnavailableError);
  });
});
