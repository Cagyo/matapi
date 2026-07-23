import { execFile as nodeExecFile } from 'node:child_process';
import { access, open, readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';

export const SANITIZED_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const READINESS_COMMAND_OPTIONS = {
  env: { PATH: SANITIZED_PATH },
  timeout: 5_000,
  maxBuffer: 4_096,
} as const;

export type FixedExecFile = (
  executable: string,
  arguments_: readonly string[],
  options: typeof READINESS_COMMAND_OPTIONS,
) => Promise<{ stdout: string; stderr: string }>;

export interface FileStat {
  uid: number;
  mode: number;
  isDirectory(): boolean;
}

export function defaultExecFile(): FixedExecFile {
  return promisify(nodeExecFile) as FixedExecFile;
}

export async function openTcp(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error('readiness TCP timeout')), 5_000);
    socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

export const nodeReadinessFiles = {
  readFile: (path: string) => readFile(path, 'utf8'),
  access: (path: string) => access(path),
  stat: (path: string) => stat(path),
  openReadWrite: async (path: string) => {
    const handle = await open(path, 'r+');
    await handle.close();
  },
};

export function hasGroups(output: string, required: readonly string[]): boolean {
  const groups = new Set(output.trim().split(/\s+/u).filter(Boolean));
  return required.every((group) => groups.has(group));
}

export function modeOf(statResult: FileStat): number {
  return statResult.mode & 0o7777;
}
