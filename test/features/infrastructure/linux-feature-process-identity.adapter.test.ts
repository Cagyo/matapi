import { describe, expect, it, vi } from 'vitest';
import {
  LinuxFeatureProcessIdentityAdapter,
  type ProcessIdentityFiles,
} from '../../../src/features/infrastructure/linux-feature-process-identity.adapter';

const BOOT_ID = '4f2a6b1c-8d3e-4a5f-9b0c-1d2e3f4a5b6c';

/**
 * `/proc/self/stat` numbers fields from 1; field 3 is the first field after the
 * command name, so field 22 (start time) is index 19 of the trailing fields.
 */
function statRecord(command: string, startTicks: string, trailing = 50): string {
  const fields = Array.from({ length: trailing }, () => '0');
  fields[0] = 'S';
  fields[19] = startTicks;
  return `4242 (${command}) ${fields.slice(0, trailing).join(' ')}\n`;
}

function files(bootId: string, stat: string): ProcessIdentityFiles & {
  readBounded: ReturnType<typeof vi.fn>;
} {
  return {
    readBounded: vi.fn(async (path: string) =>
      (path === '/proc/sys/kernel/random/boot_id' ? bootId : stat)),
  };
}

describe('LinuxFeatureProcessIdentityAdapter', () => {
  it('composes the identity from the boot id and the process start ticks', async () => {
    const identity = new LinuxFeatureProcessIdentityAdapter({
      files: files(`${BOOT_ID}\n`, statRecord('node', '901234')),
    });

    await expect(identity.current()).resolves.toBe(`${BOOT_ID}:901234`);
  });

  it('parses the start time from the final closing parenthesis of the command name', async () => {
    const identity = new LinuxFeatureProcessIdentityAdapter({
      files: files(`${BOOT_ID}\n`, statRecord('node (worker) 1 2 3 4 5) x', '901234')),
    });

    await expect(identity.current()).resolves.toBe(`${BOOT_ID}:901234`);
  });

  it('reads only the two fixed proc paths, each with a bounded size', async () => {
    const seam = files(`${BOOT_ID}\n`, statRecord('node', '5'));
    const identity = new LinuxFeatureProcessIdentityAdapter({ files: seam });

    await identity.current();

    expect(seam.readBounded.mock.calls).toEqual([
      ['/proc/sys/kernel/random/boot_id', 64],
      ['/proc/self/stat', 4096],
    ]);
  });

  it('rejects a malformed boot id', async () => {
    for (const bootId of ['', 'not-a-boot-id\n', `${BOOT_ID.toUpperCase()}\n`, `${BOOT_ID}${BOOT_ID}\n`]) {
      const identity = new LinuxFeatureProcessIdentityAdapter({
        files: files(bootId, statRecord('node', '5')),
      });

      await expect(identity.current()).rejects.toThrow('Process boot identity is invalid');
    }
  });

  it('rejects a stat record that never closes the command name', async () => {
    const identity = new LinuxFeatureProcessIdentityAdapter({
      files: files(`${BOOT_ID}\n`, '4242 (node S 1 2 3'),
    });

    await expect(identity.current()).rejects.toThrow('Process start time is unavailable');
  });

  it('rejects a stat record truncated before field 22', async () => {
    const identity = new LinuxFeatureProcessIdentityAdapter({
      files: files(`${BOOT_ID}\n`, statRecord('node', '5', 19)),
    });

    await expect(identity.current()).rejects.toThrow('Process start time is unavailable');
  });

  it('rejects a start time that is not a plain non-negative integer', async () => {
    for (const ticks of ['-1', '9.5', '0x10', '12a', '1e3']) {
      const identity = new LinuxFeatureProcessIdentityAdapter({
        files: files(`${BOOT_ID}\n`, statRecord('node', ticks)),
      });

      await expect(identity.current()).rejects.toThrow('Process start time is unavailable');
    }
  });
});
