import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AesGcmArchiveSecretAdapter } from '../../../src/archive/infrastructure/persistence/aes-gcm-archive-secret.adapter';
import { DriveCredentialCorruptError } from '../../../src/archive/domain/errors/drive-credential-corrupt.error';

const context = {
  installationId: 'install-1',
  rowId: 'generation-1',
  kind: 'oauth-token' as const,
  schemaVersion: 1,
};

describe('AesGcmArchiveSecretAdapter', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('rejects a valid envelope transplanted to another secret field', async () => {
    const cipher = new AesGcmArchiveSecretAdapter(await keyPath(temporaryDirectories));
    const envelope = await cipher.encrypt(Buffer.from('secret'), context);

    await expect(cipher.decrypt(envelope, { ...context, kind: 'oauth-client' })).rejects.toThrow(DriveCredentialCorruptError);
  });

  it('never creates a replacement key when the configured key is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'home-worker-archive-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'missing.key');
    const cipher = new AesGcmArchiveSecretAdapter(path);

    await expect(cipher.encrypt(Buffer.from('secret'), context)).rejects.toThrow(DriveCredentialCorruptError);
    await expect(cipher.encrypt(Buffer.from('secret'), context)).rejects.toThrow(DriveCredentialCorruptError);
  });

  it('rejects key material that is not exactly 32 bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'home-worker-archive-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'archive.key');
    await writeFile(path, Buffer.alloc(31));

    await expect(new AesGcmArchiveSecretAdapter(path).encrypt(Buffer.from('secret'), context)).rejects.toThrow(DriveCredentialCorruptError);
  });
});

async function keyPath(temporaryDirectories: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'home-worker-archive-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'archive.key');
  await writeFile(path, Buffer.alloc(32, 7));
  return path;
}
