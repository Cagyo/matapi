import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
