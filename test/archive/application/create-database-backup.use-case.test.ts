import { describe, expect, it, vi } from 'vitest';
import { CreateDatabaseBackupUseCase } from '../../../src/archive/application/use-cases/create-database-backup.use-case';
import type { ArchiveArtifactRepositoryPort, ArchiveSchedulerState } from '../../../src/archive/application/ports/archive-artifact-repository.port';
import type { ArchiveRegistrationPort } from '../../../src/archive/application/ports/archive-registration.port';
import type { DatabaseBackupSnapshotPort } from '../../../src/database/application/ports/database-backup-snapshot.port';

const now = Date.parse('2026-07-29T12:00:00.000Z');

describe('CreateDatabaseBackupUseCase', () => {
  it('creates a catch-up backup after 24 elapsed hours without acquiring a transfer slot', async () => {
    const schedulerState: ArchiveSchedulerState = {
      revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null,
      lastBackupSuccessMs: now - 24 * 60 * 60 * 1000 - 1,
      lastUploadSuccessMs: null, lastReconcileSuccessMs: null, lastCleanupSuccessMs: null,
    };
    const repository = fakeRepository(schedulerState);
    const snapshots = fakeSnapshots();
    const archive: ArchiveRegistrationPort = { register: vi.fn(async () => ({}) as never) };
    const transferSemaphore = { acquire: vi.fn() };
    const useCase = new CreateDatabaseBackupUseCase(snapshots, archive, repository, 'installation-1', { timezone: 'Europe/Kyiv' });

    await expect(useCase.execute({ nowMs: now })).resolves.toEqual({ created: true, reason: 'catchup' });

    expect(archive.register).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 'installation-1', kind: 'database_backup', trustedPath: '/backups/worker.db',
    }));
    expect(transferSemaphore.acquire).not.toHaveBeenCalled();
    expect(schedulerState.lastBackupSuccessMs).toBe(now);
  });

  it('uses a timezone-aware calendar day for scheduled backups while catch-up remains elapsed-time based', async () => {
    const repository = fakeRepository({
      revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null,
      lastBackupSuccessMs: Date.parse('2026-07-28T22:30:00.000Z'),
      lastUploadSuccessMs: null, lastReconcileSuccessMs: null, lastCleanupSuccessMs: null,
    });
    const useCase = new CreateDatabaseBackupUseCase(fakeSnapshots(), { register: vi.fn(async () => ({}) as never) }, repository, 'installation-1', { timezone: 'Europe/Kyiv' });

    expect(useCase.isScheduledForNewLocalDay(
      Date.parse('2026-07-29T21:30:00.000Z'),
      Date.parse('2026-07-28T22:30:00.000Z'),
    )).toBe(true);
    expect(useCase.isCatchupDue(
      Date.parse('2026-07-29T21:30:00.000Z'),
      Date.parse('2026-07-28T22:30:00.000Z'),
    )).toBe(false);
  });

  it('does not prune an unverified artifact path after registration', async () => {
    const repository = fakeRepository({
      revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null,
      lastBackupSuccessMs: null, lastUploadSuccessMs: null, lastReconcileSuccessMs: null, lastCleanupSuccessMs: null,
    });
    const snapshots = fakeSnapshots();
    repository.listUnverifiedArtifactPaths = vi.fn(async () => ['/backups/worker.db']);
    const useCase = new CreateDatabaseBackupUseCase(snapshots, { register: vi.fn(async () => ({}) as never) }, repository, 'installation-1', { timezone: 'Europe/Kyiv' });

    await useCase.execute({ nowMs: now });

    expect(snapshots.pruneLocalSnapshots).toHaveBeenCalledWith(expect.objectContaining({
      pinnedPaths: new Set(['/backups/worker.db']),
    }));
  });
});

function fakeSnapshots(): DatabaseBackupSnapshotPort & { pruneLocalSnapshots: ReturnType<typeof vi.fn> } {
  const descriptor = {
    kind: 'database_backup' as const, sourceIdentity: 'database:worker.db', trustedPath: '/backups/worker.db', relativePath: 'worker.db',
    size: 42, mtimeNs: '123', sourceTimeMs: now, sha256: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
  };
  return {
    createOrLocateCompletedSnapshot: vi.fn(async () => descriptor),
    removeStaleTemporarySnapshots: vi.fn(async () => 0),
    listCompletedSnapshots: vi.fn(async () => [descriptor]),
    pruneLocalSnapshots: vi.fn(async () => []),
  };
}

function fakeRepository(state: ArchiveSchedulerState): ArchiveArtifactRepositoryPort & { listUnverifiedArtifactPaths: ReturnType<typeof vi.fn> } {
  return {
    readSchedulerState: vi.fn(async () => ({ ...state })),
    compareAndSetSchedulerState: vi.fn(async (revision: number, update) => {
      if (state.revision !== revision) return false;
      Object.assign(state, update, { revision: state.revision + 1 });
      return true;
    }),
    listUnverifiedArtifactPaths: vi.fn(async () => []),
  } as unknown as ArchiveArtifactRepositoryPort & { listUnverifiedArtifactPaths: ReturnType<typeof vi.fn> };
}
