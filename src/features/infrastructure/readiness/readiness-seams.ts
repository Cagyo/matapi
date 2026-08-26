import { execFile as nodeExecFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';

export const SANITIZED_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const READINESS_COMMAND_OPTIONS = {
  env: { PATH: SANITIZED_PATH },
  timeout: 5_000,
  // 64 KiB, matching EXEC_OPTIONS in src/sensors/infrastructure/libgpiod-cli.backend.ts.
  // The previous 4 KiB truncated a Pi 5 `gpioinfo` dump (4261 bytes) into an
  // ERR_CHILD_PROCESS_STDIO_MAXBUFFER rejection that read as a permission fault.
  maxBuffer: 64 * 1024,
} as const;

/** The one bound on anything a privileged helper or its artifacts can hand back. */
export const READINESS_MAX_OUTPUT_BYTES = READINESS_COMMAND_OPTIONS.maxBuffer;

export type FixedExecFile = (
  executable: string,
  arguments_: readonly string[],
  options: typeof READINESS_COMMAND_OPTIONS,
) => Promise<{ stdout: string; stderr: string }>;

/**
 * One descriptor's own metadata plus the bytes read through it.
 *
 * The checks and the read share a single descriptor on purpose: a caller that
 * stats a path, then opens it, validates a file that a rename may already have
 * replaced.
 */
export interface SealedFile {
  uid: number;
  gid: number;
  /** Permission bits only. */
  mode: number;
  size: number;
  nlink: number;
  isFile: boolean;
  /** At most `maxBytes + 1` bytes, so an oversized file is detectable. */
  content: string;
}

export type ReadSealedFile = (path: string, maxBytes: number) => Promise<SealedFile>;

export interface FileStat {
  uid: number;
  gid: number;
  mode: number;
  isDirectory(): boolean;
}

export function defaultExecFile(): FixedExecFile {
  return promisify(nodeExecFile);
}

export async function openTcp(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error('readiness TCP timeout')), 5_000);
    socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Open a fixed path without following a symlink and read it under a cap. */
export async function readSealedFile(path: string, maxBytes: number): Promise<SealedFile> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    // Read to EOF or to one byte past the cap, so a short read cannot present a
    // truncated artifact as a complete one.
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      filled += bytesRead;
      if (bytesRead === 0 || filled === buffer.length) break;
    }
    return {
      uid: info.uid,
      gid: info.gid,
      mode: info.mode & 0o7777,
      size: info.size,
      nlink: info.nlink,
      isFile: info.isFile(),
      content: buffer.subarray(0, filled).toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

export const nodeReadinessFiles = {
  readFile: (path: string) => readFile(path, 'utf8'),
  access: (path: string, mode: number) => access(path, mode),
  stat: (path: string) => stat(path),
  openReadWrite: async (path: string) => {
    const handle = await open(path, 'r+');
    await handle.close();
  },
  readSealed: readSealedFile,
};

export const READINESS_MEDIA_DIRECTORY_ACCESS = constants.W_OK | constants.X_OK;

export function hasGroups(output: string, required: readonly string[]): boolean {
  const groups = new Set(output.trim().split(/\s+/u).filter(Boolean));
  return required.every((group) => groups.has(group));
}

export function modeOf(statResult: FileStat): number {
  return statResult.mode & 0o7777;
}
