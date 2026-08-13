import { describe, expect, it, vi } from 'vitest';
import type { ArchiveUploadSourcePort } from '../../../src/archive/application/use-cases/upload-drive-object-attempt.use-case';
import type { DriveArchivePort } from '../../../src/archive/application/ports/drive-archive.port';
import { ReconcileDriveUseCase } from '../../../src/archive/application/use-cases/reconcile-drive.use-case';
import { encodeArchiveAppProperties } from '../../../src/archive/domain/app-properties';
import { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import type { VerifiedDriveObject } from '../../../src/archive/domain/drive-object-metadata.value-object';
import { DriveFolderBranchBlockedError } from '../../../src/archive/domain/errors/drive-folder-branch-blocked.error';
import { DriveObjectConflictError } from '../../../src/archive/domain/errors/drive-object-conflict.error';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';

const NOW = 2_000;
const DIGEST = '25bf8e1a2393f1108d37029b3df5593236c755742ec93465bbafa9b290bddcf6';
const FINGERPRINT = 'b'.repeat(64);
const signal = new AbortController().signal;

function connection() {
  return DriveConnection.restore({
    id: 'generation-1',
    installationId: 'installation-1',
    status: 'active',
    revision: 1,
    permissionId: 'owner-1',
    email: null,
    displayName: null,
    folders: { rootId: 'root-1', motionId: 'motion-1', backupsId: 'backups-1' },
    createdAtMs: 1,
    updatedAtMs: 1,
    activatedAtMs: 1,
    retiredAtMs: null,
  });
}

function remote(overrides: Partial<VerifiedDriveObject> = {}): VerifiedDriveObject {
  return {
    id: 'file-1',
    name: 'clip.mp4',
    parentId: 'motion-1',
    mimeType: 'video/mp4',
    size: 5,
    sha256: DIGEST,
    md5: 'c'.repeat(32),
    createdTimeMs: 1_000,
    headRevisionId: 'head-1',
    version: '1',
    ownedByMe: true,
    canDelete: true,
    trashed: false,
    appProperties: encodeArchiveAppProperties({
      installationId: 'installation-1',
      generationId: 'generation-1',
      kind: 'motion_video',
      sourceFingerprint: FINGERPRINT,
      sha256: DIGEST,
      sourceTimeMs: 500,
      schemaVersion: 1,
    }),
    sharing: {
      ownerPermissionId: 'owner-1',
      shared: false,
      permissionIds: ['owner-1'],
    },
    webViewLink: 'https://drive.example/file-1',
    ...overrides,
  };
}

class FakeDrive implements DriveArchivePort {
  object: VerifiedDriveObject | null = remote();
  readonly objects = new Map<string, VerifiedDriveObject>();
  listed: VerifiedDriveObject[][] = [];
  incompleteSearch = false;
  readonly generatedIds: string[] = [];
  readonly loadObject = vi.fn(async (_connection, fileId: string) =>
    this.objects.get(fileId) ?? (this.object?.id === fileId ? this.object : null),
  );
  async generateFileId() {
    const id = `replacement-${this.generatedIds.length + 1}`;
    this.generatedIds.push(id);
    return id;
  }
  readonly listManagedObjects = vi.fn(async (input: { parentId: string; pageToken: string | null }) => {
    const page = input.pageToken === null ? 0 : Number(input.pageToken);
    return {
      objects: (this.listed[page] ?? []).filter((object) => object.parentId === input.parentId),
      nextPageToken: page + 1 < this.listed.length ? String(page + 1) : null,
      incompleteSearch: this.incompleteSearch,
    };
  });
  async beginResumableUpload(): Promise<never> { throw new Error('not used'); }
  async querySession(): Promise<never> { throw new Error('not used'); }
  async uploadChunk(): Promise<never> { throw new Error('not used'); }
  async deleteExact(): Promise<void> { throw new Error('reconciliation must not delete Drive objects'); }
}

function source(available = true): ArchiveUploadSourcePort {
  return {
    stat: async () => {
      if (!available) throw new Error('ENOENT');
      return { size: 5, mtimeNs: '500000000' };
    },
    open: async function* () {
      if (!available) throw new Error('ENOENT');
      yield Buffer.from('local');
    },
  };
}

async function fixture(localAvailable = true) {
  const repository = new InMemoryArchiveArtifactRepository();
  const active = connection();
  const artifact = await repository.register({
    installationId: active.installationId,
    kind: 'motion_video',
    sourceIdentity: 'motion:clip',
    trustedPath: '/motion/clip.mp4',
    relativePath: '2026/08/13/120000-clip.mp4',
    size: 5,
    mtimeNs: '500000000',
    sourceTimeMs: 500,
    sha256: DIGEST,
    sourceFingerprint: FINGERPRINT,
  });
  const attempt = await repository.createAttempt(
    artifact.id,
    active.id,
    'file-1',
    active.folders!.motionId,
    1_000,
  );
  const claimed = await repository.claimAttempt(attempt.id, {
    owner: 'upload',
    nowMs: 1_100,
    leaseMs: 10_000,
  });
  await repository.markVerified(attempt.id, claimed.lease, archiveObject(remote()), 1_200);
  const drive = new FakeDrive();
  const resolver = { execute: vi.fn().mockResolvedValue(active.folders!.motionId) };
  const alerts: { kind: string; generationId: string; artifactId?: string }[] = [];
  const reconcile = Reflect.construct(ReconcileDriveUseCase, [
    repository,
    { loadActive: async () => active },
    drive,
    source(localAvailable),
    { alert: async (kind, context) => void alerts.push({ kind, ...context }) },
    resolver,
    { now: () => NOW, pageSize: 2, maxPages: 4 },
  ]) as ReconcileDriveUseCase;
  return { repository, artifact, drive, reconcile, alerts, active, resolver };
}

describe('ReconcileDriveUseCase', () => {
  it.each([
    ['moved', { parentId: 'elsewhere' }],
    ['shared', { sharing: { ownerPermissionId: 'owner-1', shared: true, permissionIds: ['owner-1', 'reader-1'] } }],
    ['ownership-changed', { sharing: { ownerPermissionId: 'owner-2', shared: false, permissionIds: ['owner-2'] } }],
    ['content-replaced', { sha256: 'd'.repeat(64), headRevisionId: 'head-2', version: '2' }],
    ['version-changed', { version: '2' }],
  ] as const)('marks %s attempts detached and keeps detachment sticky', async (_change, update) => {
    const fixtureValue = await fixture();
    fixtureValue.drive.object = remote(update);

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);
    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id))[0].state).toBe('detached');

    fixtureValue.drive.object = remote();
    await fixtureValue.reconcile.execute({ limit: 20 }, signal);
    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id))[0].state).toBe('detached');
    expect(fixtureValue.drive.loadObject).toHaveBeenCalledTimes(1);
  });

  it('accepts a manual rename only when every non-name field still matches', async () => {
    const fixtureValue = await fixture();
    fixtureValue.drive.object = remote({ name: 'renamed.mp4', version: '2' });

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    const [attempt] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    expect(attempt).toMatchObject({
      state: 'verified',
      verifiedObject: { name: 'renamed.mp4', version: '2' },
    });
  });

  it('marks missing by exact ID and creates a replacement only from an unchanged trusted source', async () => {
    const fixtureValue = await fixture();
    fixtureValue.drive.object = null;

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    const attempts = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    expect(attempts.map((attempt) => [attempt.remoteObjectId, attempt.state])).toEqual([
      ['file-1', 'missing'],
      ['replacement-1', 'pending'],
    ]);
    expect(fixtureValue.alerts).toEqual([]);
  });

  it('keeps an existing verified flat object valid against its stored attempt parent', async () => {
    const fixtureValue = await fixture();
    fixtureValue.drive.object = remote({ parentId: fixtureValue.active.folders!.motionId });

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id))[0].state).toBe('verified');
    expect(fixtureValue.resolver.execute).not.toHaveBeenCalled();
  });

  it('recreates a removed flat object under the resolved day only when the source survives', async () => {
    const fixtureValue = await fixture(true);
    fixtureValue.drive.object = null;
    fixtureValue.resolver.execute.mockResolvedValue('day-folder-1');

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id)).map((attempt) => [
      attempt.containerId, attempt.state,
    ])).toEqual([
      [fixtureValue.active.folders!.motionId, 'missing'],
      ['day-folder-1', 'pending'],
    ]);
  });

  it('replaces missing nested objects under their resolved day folder', async () => {
    const fixtureValue = await fixture(true);
    const [flat] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    await fixtureValue.repository.markMissing(flat.id, flat.revision, 'old', NOW);
    const nested = await fixtureValue.repository.createAttempt(
      fixtureValue.artifact.id, fixtureValue.active.id, 'nested-file', 'day-13', NOW,
    );
    const claimed = await fixtureValue.repository.claimAttempt(nested.id, {
      owner: 'nested-upload', nowMs: NOW, leaseMs: 1_000,
    });
    await fixtureValue.repository.markVerified(
      nested.id, claimed.lease, archiveObject(remote({ id: 'nested-file', parentId: 'day-13' })), NOW,
    );
    fixtureValue.drive.object = null;
    fixtureValue.resolver.execute.mockResolvedValue('day-replacement');

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id)).map((attempt) => [
      attempt.containerId, attempt.state,
    ])).toEqual(expect.arrayContaining([
      ['motion-1', 'missing'],
      ['day-13', 'missing'],
      ['day-replacement', 'pending'],
    ]));
  });

  it.each([null, remote({ id: 'nested-file', parentId: 'day-13', trashed: true })])(
    'replaces a missing or trashed nested object under a newly resolved day',
    async (nestedRemote) => {
      const fixtureValue = await fixture(true);
      const [flat] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
      await fixtureValue.repository.markMissing(flat.id, flat.revision, 'old', NOW);
      const nested = await fixtureValue.repository.createAttempt(
        fixtureValue.artifact.id, fixtureValue.active.id, 'nested-file', 'day-13', NOW,
      );
      const claimed = await fixtureValue.repository.claimAttempt(nested.id, {
        owner: 'nested-upload', nowMs: NOW, leaseMs: 1_000,
      });
      await fixtureValue.repository.markVerified(
        nested.id, claimed.lease, archiveObject(remote({ id: 'nested-file', parentId: 'day-13' })), NOW,
      );
      fixtureValue.drive.object = nestedRemote;
      fixtureValue.resolver.execute.mockResolvedValue('day-replacement');

      await fixtureValue.reconcile.execute({ limit: 20 }, signal);

      const attempts = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
      expect(attempts.find(({ containerId }) => containerId === 'day-13')).toMatchObject({
        containerId: 'day-13', state: 'missing',
      });
      expect(attempts.find(({ containerId }) => containerId === 'day-replacement')).toMatchObject({
        containerId: 'day-replacement', state: 'pending',
      });
    },
  );

  it('keeps an unchanged nested object authorized by its immutable attempt container', async () => {
    const fixtureValue = await fixture();
    const [flat] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    await fixtureValue.repository.markMissing(flat.id, flat.revision, 'old', NOW);
    const nested = await fixtureValue.repository.createAttempt(
      fixtureValue.artifact.id, fixtureValue.active.id, 'nested-file', 'day-13', NOW,
    );
    const claimed = await fixtureValue.repository.claimAttempt(nested.id, {
      owner: 'nested-upload', nowMs: NOW, leaseMs: 1_000,
    });
    const nestedRemote = remote({ id: 'nested-file', parentId: 'day-13', canDelete: true });
    await fixtureValue.repository.markVerified(nested.id, claimed.lease, archiveObject(nestedRemote), NOW);
    fixtureValue.drive.object = nestedRemote;

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id)).find(({ id }) => id === nested.id))
      .toMatchObject({ state: 'verified', containerId: 'day-13', verifiedObject: { canDelete: true } });
  });

  it('groups restoration listings by resolved day folder', async () => {
    const fixtureValue = await fixture();
    await registerPending(fixtureValue.repository, fixtureValue.active, '2026/08/13/120001-a.mp4', 'c');
    await registerPending(fixtureValue.repository, fixtureValue.active, '2026/08/13/120002-b.mp4', 'd');
    await registerPending(fixtureValue.repository, fixtureValue.active, '2026/08/14/120003-c.mp4', 'e');
    fixtureValue.resolver.execute.mockImplementation(async (_connection, path) =>
      path.dayPath === '2026/08/13' ? 'day-13' : 'day-14');

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect(fixtureValue.drive.listManagedObjects).toHaveBeenCalledTimes(2);
    expect(fixtureValue.drive.listManagedObjects.mock.calls.map(([input]) => input.parentId).sort())
      .toEqual(['day-13', 'day-14']);
  });

  it('skips a blocked motion branch while restoring healthy folders', async () => {
    const fixtureValue = await fixture();
    const healthy = await registerPending(
      fixtureValue.repository, fixtureValue.active, '2026/08/14/120003-c.mp4', 'c',
    );
    await registerPending(fixtureValue.repository, fixtureValue.active, '2026/08/13/120002-b.mp4', 'd');
    fixtureValue.resolver.execute.mockImplementation(async (_connection, path) => {
      if (path.dayPath === '2026/08/13') throw new DriveFolderBranchBlockedError();
      return 'day-14';
    });
    fixtureValue.drive.listed = [[managedRemote(healthy, 'restored-healthy', 'day-14')]];

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(healthy.id)).at(-1)?.state).toBe('verified');
  });

  it('skips terminal invalid motion artifacts and restores a later healthy day group', async () => {
    const fixtureValue = await fixture();
    const invalid = await fixtureValue.repository.register({
      installationId: fixtureValue.active.installationId,
      kind: 'motion_video',
      sourceIdentity: 'motion:invalid',
      trustedPath: '/motion/invalid.mp4',
      relativePath: 'not-a-motion-path.mp4',
      size: 5,
      mtimeNs: '500000000',
      sourceTimeMs: 500,
      sha256: DIGEST,
      sourceFingerprint: 'f'.repeat(64),
    });
    const terminal = await fixtureValue.repository.markAdmissionTerminal(
      invalid.id, invalid.admission.revision, 'invalid_motion_path', NOW,
    );
    const healthy = await registerPending(
      fixtureValue.repository, fixtureValue.active, '2026/08/14/120003-healthy.mp4', 'c',
    );
    vi.spyOn(fixtureValue.repository, 'listRestorationCandidates').mockResolvedValue([terminal, healthy]);
    fixtureValue.resolver.execute.mockResolvedValue('day-14');
    fixtureValue.drive.listed = [[managedRemote(healthy, 'restored-healthy', 'day-14')]];

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(healthy.id)).at(-1)).toMatchObject({
      remoteObjectId: 'restored-healthy', state: 'verified',
    });
  });

  it('terminalizes an invalid oldest candidate so the next limited run restores a healthy artifact', async () => {
    const fixtureValue = await fixture();
    vi.spyOn(Date, 'now').mockReturnValueOnce(1).mockReturnValueOnce(2);
    const invalid = await fixtureValue.repository.register({
      installationId: fixtureValue.active.installationId,
      kind: 'motion_video',
      sourceIdentity: 'motion:legacy-invalid',
      trustedPath: '/motion/legacy-invalid.mp4',
      relativePath: 'legacy-invalid.mp4',
      size: 5,
      mtimeNs: '500000000',
      sourceTimeMs: 500,
      sha256: DIGEST,
      sourceFingerprint: 'e'.repeat(64),
    });
    const healthy = await registerPending(
      fixtureValue.repository, fixtureValue.active, '2026/08/14/120003-healthy.mp4', 'f',
    );
    fixtureValue.resolver.execute.mockResolvedValue('day-14');
    fixtureValue.drive.listed = [[managedRemote(healthy, 'restored-healthy', 'day-14')]];

    await fixtureValue.reconcile.execute({ limit: 1 }, signal);
    expect(await fixtureValue.repository.loadArtifact(invalid.id)).toMatchObject({
      admission: { state: 'terminal', errorCode: 'invalid_motion_path' },
    });

    await fixtureValue.reconcile.execute({ limit: 1 }, signal);
    expect((await fixtureValue.repository.listAttempts(healthy.id)).at(-1)).toMatchObject({
      remoteObjectId: 'restored-healthy', state: 'verified',
    });
  });

  it('does not adopt a remote-only flat video when its source no longer survives', async () => {
    const fixtureValue = await fixture(false);
    const [attempt] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    await fixtureValue.repository.markMissing(attempt.id, attempt.revision, 'missing', NOW);
    fixtureValue.drive.object = null;
    fixtureValue.drive.listed = [[remote({ id: 'remote-only' })]];

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id)).map(({ remoteObjectId }) => remoteObjectId))
      .toEqual(['file-1']);
  });

  it('does not adopt duplicate leaf candidates or incomplete restoration searches', async () => {
    const fixtureValue = await fixture();
    const [attempt] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    await fixtureValue.repository.markMissing(attempt.id, attempt.revision, 'missing', NOW);
    fixtureValue.drive.object = null;
    fixtureValue.drive.listed = [[remote({ id: 'candidate-a' }), remote({ id: 'candidate-b' })]];

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);
    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id)).map(({ remoteObjectId }) => remoteObjectId))
      .toEqual(['file-1']);

    fixtureValue.drive.incompleteSearch = true;
    await fixtureValue.reconcile.execute({ limit: 20 }, signal);
    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id)).map(({ remoteObjectId }) => remoteObjectId))
      .toEqual(['file-1']);
  });

  it('restores a valid flat motion object when no date-container resolver is composed', async () => {
    const fixtureValue = await fixture();
    const [attempt] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    await fixtureValue.repository.markMissing(attempt.id, attempt.revision, 'missing', NOW);
    fixtureValue.drive.object = null;
    fixtureValue.drive.listed = [[remote({ id: 'flat-restored' })]];
    const withoutResolver = new ReconcileDriveUseCase(
      fixtureValue.repository,
      { loadActive: async () => fixtureValue.active },
      fixtureValue.drive,
      source(),
      { alert: async () => undefined },
      { now: () => NOW, pageSize: 2, maxPages: 4 },
    );

    await withoutResolver.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id)).at(-1)).toMatchObject({
      remoteObjectId: 'flat-restored', state: 'verified', containerId: 'motion-1',
    });
  });

  it('does not adopt when a leaf listing exceeds the configured page bound', async () => {
    const fixtureValue = await fixture();
    const [attempt] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    await fixtureValue.repository.markMissing(attempt.id, attempt.revision, 'missing', NOW);
    fixtureValue.drive.object = null;
    fixtureValue.drive.listed = Array.from({ length: 5 }, () => [remote({ id: 'candidate' })]);

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id)).map(({ remoteObjectId }) => remoteObjectId))
      .toEqual(['file-1']);
    expect(fixtureValue.drive.listManagedObjects).toHaveBeenCalledTimes(4);
  });

  it('preserves history and alerts when a missing object has no trusted local source', async () => {
    const fixtureValue = await fixture(false);
    fixtureValue.drive.object = null;

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    const attempts = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    expect(attempts.map((attempt) => attempt.state)).toEqual(['missing']);
    expect(fixtureValue.drive.generatedIds).toEqual([]);
    expect(fixtureValue.alerts).toEqual([
      { kind: 'remote-object-missing', generationId: fixtureValue.active.id, artifactId: fixtureValue.artifact.id },
    ]);
  });

  it('keeps the missing object retryable until a replacement ID is reserved', async () => {
    const fixtureValue = await fixture();
    fixtureValue.drive.object = null;
    vi.spyOn(fixtureValue.drive, 'generateFileId').mockRejectedValueOnce(
      new Error('temporary reservation failure'),
    );

    await expect(fixtureValue.reconcile.execute({ limit: 20 }, signal))
      .rejects.toThrow('temporary reservation failure');

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id))[0].state)
      .toBe('verified');
  });

  it('atomically preserves the verified attempt when inserting the reserved replacement fails', async () => {
    const fixtureValue = await fixture();
    fixtureValue.drive.object = null;
    const conflicting = await registerPending(
      fixtureValue.repository,
      fixtureValue.active,
      '2026/08/13/conflicting.mp4',
      'c',
    );
    await fixtureValue.repository.createAttempt(
      conflicting.id,
      fixtureValue.active.id,
      'already-reserved',
      fixtureValue.active.folders!.motionId,
      1_500,
    );
    vi.spyOn(fixtureValue.drive, 'generateFileId').mockResolvedValueOnce('already-reserved');

    await expect(fixtureValue.reconcile.execute({ limit: 20 }, signal))
      .rejects.toThrow('Reserved remote object ID already exists');

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id))[0].state)
      .toBe('verified');
  });

  it('keeps a missing object runnable until its mandatory durable alert is accepted', async () => {
    const fixtureValue = await fixture(false);
    fixtureValue.drive.object = null;
    const failing = new ReconcileDriveUseCase(
      fixtureValue.repository,
      { loadActive: async () => fixtureValue.active },
      fixtureValue.drive,
      source(false),
      { alert: async () => { throw new Error('durable alert unavailable'); } },
      { now: () => NOW, pageSize: 2, maxPages: 4 },
    );

    await expect(failing.execute({ limit: 20 }, signal))
      .rejects.toThrow('durable alert unavailable');

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id))[0].state)
      .toBe('verified');
  });

  it('treats Trash as missing and never calls Drive deletion', async () => {
    const fixtureValue = await fixture();
    fixtureValue.drive.object = remote({ trashed: true });

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id))[0].state).toBe('missing');
  });

  it('paginates restore discovery and adopts only one unambiguous exact managed match', async () => {
    const fixtureValue = await fixture();
    await fixtureValue.repository.markMissing(
      (await fixtureValue.repository.listAttempts(fixtureValue.artifact.id))[0].id,
      (await fixtureValue.repository.listAttempts(fixtureValue.artifact.id))[0].revision,
      'restored_manifest_gap',
      NOW,
    );
    fixtureValue.drive.object = null;
    fixtureValue.drive.listed = [[], [remote({ id: 'restored-file' })]];

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    const attempts = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    expect(attempts.at(-1)).toMatchObject({
      remoteObjectId: 'restored-file',
      state: 'verified',
    });
  });

  it('does not adopt ambiguous restored objects', async () => {
    const fixtureValue = await fixture();
    const [attempt] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    await fixtureValue.repository.markMissing(attempt.id, attempt.revision, 'restored_manifest_gap', NOW);
    fixtureValue.drive.object = null;
    fixtureValue.drive.listed = [[
      remote({ id: 'restored-a' }),
      remote({ id: 'restored-b' }),
    ]];

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id)).map((entry) => entry.remoteObjectId))
      .toEqual(['file-1']);
  });

  it('never re-adopts a remote ID recorded in terminal immutable history', async () => {
    const fixtureValue = await fixture();
    const [historical] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    await fixtureValue.repository.markMissing(
      historical.id,
      historical.revision,
      'remote_missing',
      NOW,
    );
    const second = await registerPending(
      fixtureValue.repository,
      fixtureValue.active,
      '2026/08/13/120001-second.mp4',
      'd',
    );
    fixtureValue.drive.object = null;
    fixtureValue.drive.listed = [[
      remote({ id: 'file-1' }),
      managedRemote(second, 'restored-second'),
    ]];

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect((await fixtureValue.repository.listAttempts(fixtureValue.artifact.id))[0].state)
      .toBe('missing');
    expect((await fixtureValue.repository.listAttempts(second.id)).at(-1)).toMatchObject({
      remoteObjectId: 'restored-second',
      state: 'verified',
    });
  });

  it('isolates one restoration CAS conflict so later artifacts are still recovered', async () => {
    const fixtureValue = await fixture();
    const [original] = await fixtureValue.repository.listAttempts(fixtureValue.artifact.id);
    await fixtureValue.repository.markMissing(original.id, original.revision, 'remote_missing', NOW);
    const first = await registerPending(
      fixtureValue.repository,
      fixtureValue.active,
      '2026/08/13/120001-first-restore.mp4',
      'd',
    );
    const second = await registerPending(
      fixtureValue.repository,
      fixtureValue.active,
      '2026/08/13/120002-second-restore.mp4',
      'e',
    );
    const [conflictedArtifact, recoveredArtifact] = [first, second].sort(
      (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
    );
    fixtureValue.drive.object = null;
    fixtureValue.drive.listed = [[
      managedRemote(conflictedArtifact, 'restore-conflict'),
      managedRemote(recoveredArtifact, 'restore-success'),
    ]];
    const adopt = fixtureValue.repository.adoptVerifiedObject.bind(fixtureValue.repository);
    let conflictPending = true;
    vi.spyOn(fixtureValue.repository, 'adoptVerifiedObject').mockImplementation(async (...args) => {
      if (conflictPending) {
        conflictPending = false;
        throw new DriveObjectConflictError('simulated concurrent restoration');
      }
      return adopt(...args);
    });

    await fixtureValue.reconcile.execute({ limit: 20 }, signal);

    expect(await fixtureValue.repository.listAttempts(conflictedArtifact.id)).toEqual([]);
    expect((await fixtureValue.repository.listAttempts(recoveredArtifact.id)).at(-1)).toMatchObject({
      remoteObjectId: 'restore-success',
      state: 'verified',
    });
  });

  it('durably rotates a fixed reconciliation limit across all verified attempts', async () => {
    const repository = new InMemoryArchiveArtifactRepository();
    const active = connection();
    const drive = new FakeDrive();
    drive.object = null;
    for (let index = 1; index <= 3; index += 1) {
      const artifact = await registerPending(
        repository,
        active,
        `2026/08/13/12000${index}-fair.mp4`,
        String(index),
      );
      const value = managedRemote(artifact, `fair-file-${index}`);
      drive.objects.set(value.id, value);
      const attempt = await repository.createAttempt(
        artifact.id,
        active.id,
        value.id,
        active.folders!.motionId,
        1_000 + index,
      );
      const claimed = await repository.claimAttempt(attempt.id, {
        owner: `upload-${index}`,
        nowMs: 1_100 + index,
        leaseMs: 100_000,
      });
      await repository.markVerified(
        attempt.id,
        claimed.lease,
        archiveObject(value),
        1_000 + index * 10_000,
      );
    }
    let now = 500;
    const reconcile = new ReconcileDriveUseCase(
      repository,
      { loadActive: async () => active },
      drive,
      source(),
      { alert: async () => undefined },
      { now: () => now++, pageSize: 2, maxPages: 4 },
    );

    await reconcile.execute({ limit: 1 }, signal);
    await reconcile.execute({ limit: 1 }, signal);

    expect(drive.loadObject.mock.calls.map((call) => call[1]))
      .toEqual(['fair-file-1', 'fair-file-2']);
  });
});

async function registerPending(
  repository: InMemoryArchiveArtifactRepository,
  active: ReturnType<typeof connection>,
  relativePath: string,
  fingerprintCharacter: string,
) {
  const suffix = relativePath.replaceAll('/', '-').replace('.mp4', '');
  return repository.register({
    installationId: active.installationId,
    kind: 'motion_video',
    sourceIdentity: `motion:${suffix}`,
    trustedPath: `/motion/${suffix}.mp4`,
    relativePath,
    size: 5,
    mtimeNs: '500000000',
    sourceTimeMs: 500,
    sha256: DIGEST,
    sourceFingerprint: fingerprintCharacter.repeat(64),
  });
}

function managedRemote(
  artifact: Awaited<ReturnType<typeof registerPending>>,
  id: string,
  parentId = 'motion-1',
): VerifiedDriveObject {
  return remote({
    id,
    name: artifact.relativePath,
    parentId,
    appProperties: encodeArchiveAppProperties({
      installationId: artifact.installationId,
      generationId: 'generation-1',
      kind: artifact.kind,
      sourceFingerprint: artifact.sourceFingerprint,
      sha256: artifact.sha256,
      sourceTimeMs: artifact.sourceTimeMs,
      schemaVersion: 1,
    }),
    webViewLink: `https://drive.example/${id}`,
  });
}

function archiveObject(value: VerifiedDriveObject) {
  return {
    objectId: value.id,
    name: value.name,
    containerId: value.parentId,
    contentType: value.mimeType,
    size: value.size,
    sha256: value.sha256,
    md5: value.md5,
    providerCreatedAtMs: value.createdTimeMs,
    revisionId: value.headRevisionId,
    version: value.version,
    ownedByInstallation: value.ownedByMe,
    canDelete: value.canDelete,
    trashed: value.trashed,
    attributes: value.appProperties,
    sharing: value.sharing,
    webViewLink: value.webViewLink,
  };
}
