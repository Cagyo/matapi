import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import { AesGcmArchiveSecretAdapter } from '../../../src/archive/infrastructure/persistence/aes-gcm-archive-secret.adapter';
import { DrizzleDriveCredentialRepository } from '../../../src/archive/infrastructure/persistence/drizzle-drive-credential.repository';
import { DriveObjectConflictError } from '../../../src/archive/domain/errors/drive-object-conflict.error';

describe('DrizzleDriveCredentialRepository', () => {
  let sqlite: Database.Database;
  let directory: string;
  let repository: DrizzleDriveCredentialRepository;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    directory = await mkdtemp(join(tmpdir(), 'home-worker-archive-'));
    const keyPath = join(directory, 'archive.key');
    await writeFile(keyPath, Buffer.alloc(32, 3));
    repository = new DrizzleDriveCredentialRepository(db, new AesGcmArchiveSecretAdapter(keyPath));
  });

  afterEach(async () => {
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a second staged slot without changing the existing staged generation', async () => {
    await repository.stage(staged('generation-1'));

    await expect(repository.stage(staged('generation-2'))).rejects.toBeInstanceOf(DriveObjectConflictError);
    expect((await repository.loadStaged('receipt-1'))?.id).toBe('generation-1');
  });

  it('stores an allowlisted neutral error code rather than a provider response', async () => {
    await repository.stage(staged('generation-1'));
    await repository.storeExchangedTokens('generation-1', 0, tokens('old'));
    const { active } = await repository.activate(activation('generation-1', 1, 'permission-1'));

    await expect(repository.requireReauthorization(
      active.id, active.revision, 'Bearer eyJhbGciOiJIUzI1NiJ9.provider-error-detail', 30,
    )).resolves.toBe(true);

    const row = sqlite.prepare('SELECT error_code FROM drive_connections WHERE id = ?').get(active.id) as { error_code: string | null };
    expect(row.error_code).toBe('unknown');
    expect(row.error_code).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('activates a different confirmed identity and retires the previous generation', async () => {
    await repository.stage(staged('generation-1'));
    await repository.storeExchangedTokens('generation-1', 0, tokens('old'));
    const first = await repository.activate(activation('generation-1', 1, 'permission-old'));

    await repository.stage(staged('generation-2', { receiptId: 'receipt-2', clientIdHash: 'client-hash-2' }));
    await repository.storeExchangedTokens('generation-2', 0, tokens('new'));
    const second = await repository.activate(activation('generation-2', 1, 'permission-new'));

    expect(first.retiringId).toBeNull();
    expect(second.active.id).toBe('generation-2');
    expect(second.retiringId).toBe('generation-1');
    expect((await repository.loadActive())?.id).toBe('generation-2');
  });

  it('replaces matching credentials in place and discards a late refresh from the superseded revision', async () => {
    await repository.stage(staged('generation-1'));
    await repository.storeExchangedTokens('generation-1', 0, tokens('old'));
    const { active } = await repository.activate(activation('generation-1', 1, 'permission-1'));
    const replaced = await repository.replaceCredentials(active.id, active.revision, client(), tokens('new'));

    await expect(repository.mergeRefreshedTokens({
      generationId: active.id,
      expectedRevision: active.revision,
      tokens: { accessToken: 'late', expiryDateMs: 123, refreshToken: null, tokenType: null, scope: null },
      refreshedAtMs: 123,
    })).resolves.toBe(false);
    expect((await repository.loadCredentials(replaced.id))?.tokens.accessToken).toBe('new-access');
  });

  it('returns the existing matching generation to active after reauthorization', async () => {
    await repository.stage(staged('generation-1'));
    await repository.storeExchangedTokens('generation-1', 0, tokens('old'));
    const { active } = await repository.activate(activation('generation-1', 1, 'permission-1'));
    await repository.requireReauthorization(active.id, active.revision, 'invalid_grant', 30);
    const reauthorizationRequired = await repository.loadActive();
    if (!reauthorizationRequired) throw new Error('expected current generation');

    await repository.stage(staged('generation-2', { receiptId: 'receipt-2' }));
    await repository.storeExchangedTokens('generation-2', 0, tokens('new'));
    const replacement = await repository.activate(activation('generation-2', 1, 'permission-1'));

    expect(replacement).toMatchObject({ retiringId: null, active: { id: 'generation-1', status: 'active' } });
    expect((await repository.loadCredentials('generation-1'))?.tokens.accessToken).toBe('new-access');
  });

  it('retains a stored refresh token when a fenced refresh omits it', async () => {
    await repository.stage(staged('generation-1'));
    await repository.storeExchangedTokens('generation-1', 0, tokens('old'));
    const { active } = await repository.activate(activation('generation-1', 1, 'permission-1'));

    await expect(repository.mergeRefreshedTokens({
      generationId: active.id,
      expectedRevision: active.revision,
      tokens: { accessToken: 'refreshed-access', expiryDateMs: 456, refreshToken: null, tokenType: 'Bearer', scope: 'drive.file' },
      refreshedAtMs: 456,
    })).resolves.toBe(true);
    expect((await repository.loadCredentials(active.id))?.tokens).toMatchObject({ accessToken: 'refreshed-access', refreshToken: 'old-refresh' });
  });

  it('persists encrypted envelopes rather than OAuth plaintext', async () => {
    await repository.stage(staged('generation-1'));
    await repository.storeExchangedTokens('generation-1', 0, tokens('old'));

    const row = sqlite.prepare('SELECT client_envelope, token_envelope FROM drive_connections WHERE id = ?').get('generation-1') as { client_envelope: string; token_envelope: string };
    expect(row.client_envelope).not.toContain('client-secret');
    expect(row.token_envelope).not.toContain('old-refresh');
  });

  it('durably reserves generated folder IDs in role order before activation', async () => {
    await repository.stage(staged('generation-1'));

    const root = await repository.reserveManagedFolder({ generationId: 'generation-1', expectedRevision: 0, role: 'root', folderId: 'root-reserved' });
    expect(root).toEqual({ revision: 0, rootId: 'root-reserved', motionId: null, backupsId: null });
    const motion = await repository.reserveManagedFolder({ generationId: 'generation-1', expectedRevision: 0, role: 'motion', folderId: 'motion-reserved' });
    expect(motion).toEqual({ revision: 0, rootId: 'root-reserved', motionId: 'motion-reserved', backupsId: null });
    expect(await repository.loadManagedFolderReservation('generation-1')).toEqual(motion);

    const row = sqlite.prepare('SELECT root_folder_id, motion_folder_id, backups_folder_id FROM drive_connections WHERE id = ?').get('generation-1');
    expect(row).toEqual({ root_folder_id: 'root-reserved', motion_folder_id: 'motion-reserved', backups_folder_id: null });
  });
});

function client() {
  return { clientId: 'client-id', clientSecret: 'client-secret' };
}

function tokens(prefix: string) {
  return { accessToken: `${prefix}-access`, refreshToken: `${prefix}-refresh`, expiryDateMs: 100, tokenType: 'Bearer', scope: 'drive.file' };
}

function staged(id: string, overrides: Partial<ReturnType<typeof stagedInput>> = {}) {
  return { ...stagedInput(), id, ...overrides };
}

function stagedInput() {
  return {
    installationId: 'install-1', client: client(), clientIdHash: 'client-hash-1', adminUserId: 1, chatId: 2,
    receiptId: 'receipt-1', createdAtMs: 10, expiresAtMs: 100,
  };
}

function activation(stagedId: string, expectedRevision: number, permissionId: string) {
  return {
    stagedId, expectedRevision, permissionId, email: 'owner@example.test', displayName: 'Owner',
    folders: { rootId: 'root', motionId: 'motion', backupsId: 'backups' }, activatedAtMs: 20,
  };
}
