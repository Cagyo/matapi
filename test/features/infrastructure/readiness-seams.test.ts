import { describe, expect, it } from 'vitest';
import {
  defaultExecFile,
  READINESS_COMMAND_OPTIONS,
} from '../../../src/features/infrastructure/readiness/readiness-seams';

describe('READINESS_COMMAND_OPTIONS', () => {
  // Every other readiness test fakes execFile, and a fake cannot enforce
  // maxBuffer — which is precisely how a 4 KiB cap shipped against a Pi 5
  // `gpioinfo` that emits 4261 bytes. This case drives the real promisified
  // child so the cap is asserted, not assumed. `process.execPath` keeps it
  // portable: it runs on a macOS dev machine and on the Pi alike.
  it('does not truncate command output larger than the old 4 KiB cap', async () => {
    const payloadBytes = 8_192;
    const execFile = defaultExecFile();

    const result = await execFile(
      process.execPath,
      ['-e', `process.stdout.write('x'.repeat(${payloadBytes}))`],
      READINESS_COMMAND_OPTIONS,
    );

    expect(result.stdout).toHaveLength(payloadBytes);
  });
});
