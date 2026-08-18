import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defaultExecFile,
  nodeReadinessFiles,
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

describe('nodeReadinessFiles.openReadWrite', () => {
  // Every digital/UART readiness test fakes this seam, and a fake cannot enforce
  // the open MODE — which is exactly the kind of thing that silently rots: if
  // 'r+' is ever "simplified" to 'r', both probes start passing on a device the
  // worker cannot actually write, and every vi.fn()-based test stays green. This
  // drives the real fs.promises.open against a real temp file so the O_RDWR
  // requirement is asserted, not assumed.
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeTempFile(mode: number): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'readiness-seam-'));
    tempDirectories.push(dir);
    const file = path.join(dir, 'chardev-stub');
    await writeFile(file, 'x');
    await chmod(file, mode);
    return file;
  }

  it('resolves against a read-write file', async () => {
    const file = await makeTempFile(0o644);

    await expect(nodeReadinessFiles.openReadWrite(file)).resolves.toBeUndefined();
  });

  // Root bypasses discretionary permission checks entirely, so a 0o444 file is
  // still openable O_RDWR as root — the case would false-fail under `sudo`/CI
  // running as root rather than proving anything about the seam.
  it.skipIf(process.getuid?.() === 0)(
    'rejects an EACCES on a read-only file, pinning the open mode as O_RDWR rather than O_RDONLY',
    async () => {
      const file = await makeTempFile(0o444);

      await expect(nodeReadinessFiles.openReadWrite(file)).rejects.toMatchObject({ code: 'EACCES' });
    },
  );
});
