import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import { DriveAttemptLeaseLostError } from '../../../src/archive/domain/errors/drive-attempt-lease-lost.error';
import { DrizzleArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/drizzle-archive-artifact.repository';

describe('DrizzleArchiveArtifactRepository', () => {
  let sqlite: Database.Database;
  let repository: DrizzleArchiveArtifactRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    repository = new DrizzleArchiveArtifactRepository(db);
  });

  afterEach(() => sqlite.close());

  it('keeps historical attempt IDs after replacement', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);

    await repository.markMissing(first.id, first.revision, 'remote_missing', 101);
    await repository.createAttempt(artifact.id, 'generation-1', 'file-2', 'folder-1', 102);

    expect((await repository.listAttempts(artifact.id)).map((attempt) => attempt.remoteFileId))
      .toEqual(['file-1', 'file-2']);
  });

  it('prevents an expired lease owner from verifying an attempt', async () => {
    const artifact = await repository.register(artifactFixture());
    await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const firstClaim = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!firstClaim) throw new Error('expected claim');

    await repository.claimExpiredAttempt(firstClaim.attempt.id, { owner: 'worker-b', nowMs: 7_000, leaseMs: 5_000 });

    await expect(repository.markVerified(firstClaim.attempt.id, firstClaim.lease, verifiedObject('file-1', 'folder-1'), 7_100))
      .rejects.toBeInstanceOf(DriveAttemptLeaseLostError);
  });

  it('persists a complete verification snapshot and fences stale scheduler writers', async () => {
    const artifact = await repository.register(artifactFixture());
    await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const claim = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!claim) throw new Error('expected claim');

    await repository.markVerified(claim.attempt.id, claim.lease, verifiedObject('file-1', 'folder-1'), 1_100);

    const verified = (await repository.listAttempts(artifact.id))[0];
    expect(verified).toMatchObject({ state: 'verified', verifiedMetadata: { id: 'file-1', parentId: 'folder-1' } });
    const state = await repository.readSchedulerState();
    expect(await repository.compareAndSetSchedulerState(state.revision, { lastUploadSuccessMs: 1_100 })).toBe(true);
    expect(await repository.compareAndSetSchedulerState(state.revision, { lastUploadSuccessMs: 1_200 })).toBe(false);
  });
});

function artifactFixture() {
  return {
    installationId: 'installation-1',
    kind: 'motion_video' as const,
    sourceIdentity: 'camera-1',
    trustedPath: '/var/lib/home-worker/motion/clip.mp4',
    relativePath: 'motion/clip.mp4',
    size: 42,
    mtimeNs: '100',
    sourceTimeMs: 100,
    sha256: 'a'.repeat(64),
    sourceFingerprint: 'b'.repeat(64),
  };
}

function verifiedObject(id: string, parentId: string) {
  return {
    id,
    name: 'clip.mp4',
    parentId,
    mimeType: 'video/mp4',
    size: 42,
    sha256: 'a'.repeat(64),
    md5: 'c'.repeat(32),
    createdTimeMs: 1_000,
    headRevisionId: 'revision-1',
    version: '1',
    ownedByMe: true,
    canDelete: true,
    trashed: false,
    appProperties: { artifact: 'archive-1' },
    sharing: { ownerPermissionId: 'owner-1', shared: false, permissionIds: ['owner-1'] },
    webViewLink: null,
  };
}
