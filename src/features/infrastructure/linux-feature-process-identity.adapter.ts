import { open } from 'node:fs/promises';
import type { FeatureProcessIdentityPort } from '../domain/ports/feature-process-identity.port';

const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const BOOT_ID_MAX_BYTES = 64;
const PROC_STAT_PATH = '/proc/self/stat';
const PROC_STAT_MAX_BYTES = 4096;
/** `/proc/self/stat` field 22 (start time); field 3 is the first one after the command name. */
const START_TIME_OFFSET = 22 - 3;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const START_TICKS = /^[0-9]+$/;

export interface ProcessIdentityFiles {
  /** Reads at most `maxBytes` from a fixed proc path; proc files report size 0. */
  readBounded(path: string, maxBytes: number): Promise<string>;
}

export interface LinuxFeatureProcessIdentityDependencies {
  files?: ProcessIdentityFiles;
}

export const nodeProcessIdentityFiles: ProcessIdentityFiles = {
  readBounded: async (path, maxBytes) => {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  },
};

/**
 * Composes the process identity from the Linux boot id and this process's start
 * time. Both halves are needed: start ticks repeat across boots and the boot id
 * survives every restart within one boot.
 */
export class LinuxFeatureProcessIdentityAdapter implements FeatureProcessIdentityPort {
  private readonly files: ProcessIdentityFiles;

  constructor(dependencies: LinuxFeatureProcessIdentityDependencies = {}) {
    this.files = dependencies.files ?? nodeProcessIdentityFiles;
  }

  async current(): Promise<string> {
    const bootId = (await this.files.readBounded(BOOT_ID_PATH, BOOT_ID_MAX_BYTES)).trim();
    if (!BOOT_ID.test(bootId)) throw new RangeError('Process boot identity is invalid');
    const stat = await this.files.readBounded(PROC_STAT_PATH, PROC_STAT_MAX_BYTES);
    return `${bootId}:${startTicks(stat)}`;
  }
}

/**
 * The command name is unquoted and may contain spaces and parentheses, so the
 * fields are read from the *final* `)`; splitting the whole record would let a
 * process rename itself into another process's start time.
 */
function startTicks(stat: string): string {
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd === -1) throw new RangeError('Process start time is unavailable');
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  const ticks = fields[START_TIME_OFFSET];
  if (ticks === undefined || !START_TICKS.test(ticks)) {
    throw new RangeError('Process start time is unavailable');
  }
  return ticks;
}
