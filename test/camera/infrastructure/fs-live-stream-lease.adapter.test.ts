import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { createLiveStreamProcessId, type LiveStreamLease } from '../../../src/camera/domain/live-stream.entity';
import { FsLiveStreamLeaseAdapter } from '../../../src/camera/infrastructure/fs-live-stream-lease.adapter';

describe('FsLiveStreamLeaseAdapter', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('atomically persists a private, valid runtime lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'live-stream-lease-'));
    roots.push(root);
    const runtimeDir = join(root, 'runtime');
    const adapter = new FsLiveStreamLeaseAdapter(runtimeDir);

    await adapter.write(lease());

    expect(await adapter.read()).toEqual(lease());
    expect((await stat(join(runtimeDir, 'lease.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(runtimeDir)).mode & 0o777).toBe(0o700);
    expect(await readdir(runtimeDir)).toEqual(['lease.json']);
  });

  it('returns a safe empty state for malformed or invalid identity data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'live-stream-lease-'));
    roots.push(root);
    const adapter = new FsLiveStreamLeaseAdapter(root);
    await writeFile(join(root, 'lease.json'), JSON.stringify({ ...lease(), processIdentity: '' }));

    expect(await adapter.read()).toBeNull();

    await writeFile(join(root, 'lease.json'), '{not-json');
    expect(await adapter.read()).toBeNull();
  });

  it('clears the lease idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'live-stream-lease-'));
    roots.push(root);
    const adapter = new FsLiveStreamLeaseAdapter(root);
    await adapter.write(lease());

    await adapter.clear();
    await adapter.clear();

    expect(await adapter.read()).toBeNull();
    await expect(readFile(join(root, 'lease.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function lease(): LiveStreamLease {
  return {
    sessionNonce: 'session-123',
    pid: createLiveStreamProcessId(4321),
    processIdentity: 'linux-start:987654',
    cameraId: 'front-door',
    diagnosticExpiresAtUnixMs: 2_000_000_000_000,
    messageReferences: [{ chatId: 11, messageId: 22 }],
  };
}
