import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  DriveFolderReservationRepositoryPort,
  ReserveDriveFolder,
} from '../../../src/archive/application/ports/drive-folder-reservation-repository.port';
import type { DriveFolderReservation } from '../../../src/archive/domain/drive-folder-reservation.entity';
import { DrizzleDriveFolderReservationRepository } from '../../../src/archive/infrastructure/persistence/drizzle-drive-folder-reservation.repository';
import { InMemoryDriveFolderReservationRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-folder-reservation.repository';
import * as schema from '../../../src/database/schema';

const sqliteConnections: Database.Database[] = [];

afterEach(() => {
  for (const sqlite of sqliteConnections.splice(0)) sqlite.close();
});

describeDriveFolderReservationRepositoryContract(
  'InMemoryDriveFolderReservationRepository revalidation contract',
  async () => new InMemoryDriveFolderReservationRepository(),
);

describeDriveFolderReservationRepositoryContract(
  'DrizzleDriveFolderReservationRepository revalidation contract',
  async () => {
    const sqlite = new Database(':memory:');
    sqliteConnections.push(sqlite);
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    return new DrizzleDriveFolderReservationRepository(db);
  },
);

export function describeDriveFolderReservationRepositoryContract(
  name: string,
  create: () => Promise<DriveFolderReservationRepositoryPort>,
): void {
  describe(name, () => {
    it('claims only one due blocked head by deadline and deterministic path order', async () => {
      const repository = await create();
      await seedBlocked(repository, '2026/08/14', 'conflict', 900);
      await seedBlocked(repository, '2026/08/13', 'detached', 900);

      const [left, right] = await Promise.all([
        repository.claimNextBlockedRevalidation({
          generationId: 'generation-1', nowMs: 900, claimUntilMs: 60_900,
        }),
        repository.claimNextBlockedRevalidation({
          generationId: 'generation-1', nowMs: 900, claimUntilMs: 60_900,
        }),
      ]);

      expect([left, right].filter(Boolean)).toHaveLength(1);
      expect(left ?? right).toMatchObject({
        normalizedPath: '2026/08/13',
        nextRevalidationAtMs: 60_900,
        revalidationFailureStreak: 1,
        revision: 3,
      });
      expect(await repository.loadCurrent('generation-1', '2026/08/14'))
        .toMatchObject({ nextRevalidationAtMs: 900, revision: 2 });
    });

    it('keeps one generation-wide claim when concurrent callers observe adjacent times', async () => {
      const repository = await create();
      await seedBlocked(repository, '2026/08/14', 'conflict', 900);
      await seedBlocked(repository, '2026/08/13', 'detached', 900);

      const [left, right] = await Promise.all([
        repository.claimNextBlockedRevalidation({
          generationId: 'generation-1', nowMs: 900, claimUntilMs: 60_900,
        }),
        repository.claimNextBlockedRevalidation({
          generationId: 'generation-1', nowMs: 901, claimUntilMs: 60_901,
        }),
      ]);

      expect([left, right].filter(Boolean)).toHaveLength(1);
      expect(left ?? right).toMatchObject({ normalizedPath: '2026/08/13' });
    });

    it('claims by earliest deadline before path and ignores another generation', async () => {
      const repository = await create();
      await seedBlocked(repository, '2026/08/12', 'detached', 800);
      await seedBlocked(repository, '2026/08/11', 'conflict', 900);
      await seedBlocked(repository, '2026/08/10', 'detached', 700, 'generation-2');

      await expect(repository.claimNextBlockedRevalidation({
        generationId: 'generation-1', nowMs: 900, claimUntilMs: 60_900,
      })).resolves.toMatchObject({ normalizedPath: '2026/08/12' });
    });

    it('requests only the earliest blocked head without clearing it optimistically', async () => {
      const repository = await create();
      await seedBlocked(repository, '2026/08/14', 'conflict', 2_000);
      await seedBlocked(repository, '2026/08/13', 'detached', 1_500);

      await expect(repository.requestNextBlockedRevalidation({
        generationId: 'generation-1', nowMs: 900,
      })).resolves.toMatchObject({
        normalizedPath: '2026/08/13', state: 'detached',
        nextRevalidationAtMs: 900, revision: 3,
      });
      expect(await repository.loadCurrent('generation-1', '2026/08/14'))
        .toMatchObject({ state: 'conflict', nextRevalidationAtMs: 2_000, revision: 2 });
    });

    it('restores only the expected current detached revision', async () => {
      const repository = await create();
      const detached = await seedBlocked(repository, '2026/08/13', 'detached', 900);

      await expect(repository.restoreDetached(detached.id, detached.revision + 1, 1_000))
        .resolves.toBeNull();
      await expect(repository.restoreDetached(detached.id, detached.revision, 1_000))
        .resolves.toMatchObject({
          state: 'verified', revision: detached.revision + 1,
          errorCode: null, revalidationFailureStreak: 0,
          nextRevalidationAtMs: null, verifiedAtMs: 1_000,
        });
    });

    it('does not restore a conflict head through the detached transition', async () => {
      const repository = await create();
      const conflict = await seedBlocked(repository, '2026/08/13', 'conflict', 900);

      await expect(repository.restoreDetached(conflict.id, conflict.revision, 1_000))
        .resolves.toBeNull();
      expect(await repository.loadCurrent('generation-1', '2026/08/13'))
        .toEqual(conflict);
    });

    it('reschedules only the expected current blocked revision', async () => {
      const repository = await create();
      const detached = await seedBlocked(repository, '2026/08/13', 'detached', 900);

      await expect(repository.rescheduleBlockedRevalidation({
        id: detached.id,
        expectedRevision: detached.revision + 1,
        errorCode: 'stale_probe',
        nowMs: 1_000,
        nextRevalidationAtMs: 1_801_000,
      })).resolves.toBeNull();
      await expect(repository.rescheduleBlockedRevalidation({
        id: detached.id,
        expectedRevision: detached.revision,
        errorCode: 'invariant_failed',
        nowMs: 1_000,
        nextRevalidationAtMs: 1_801_000,
      })).resolves.toMatchObject({
        state: 'detached', revision: detached.revision + 1,
        errorCode: 'invariant_failed', revalidationFailureStreak: 2,
        nextRevalidationAtMs: 1_801_000,
      });
    });

    it('adopts one surviving conflict identity in a new verified current row', async () => {
      const repository = await create();
      const conflict = await seedBlocked(repository, '2026/08/13', 'conflict', 900);

      const result = await repository.adoptConflictCandidate({
        expected: { id: conflict.id, revision: conflict.revision },
        replacement: replacementFor(conflict, 'adopted-reservation', 'survivor-id'),
        nowMs: 1_000,
      });

      expect(result).toMatchObject({
        kind: 'stored',
        reservation: {
          id: 'adopted-reservation', state: 'verified', folderId: 'survivor-id',
          currentSlot: 1, revalidationFailureStreak: 0,
          nextRevalidationAtMs: null, verifiedAtMs: 1_000,
        },
      });
      expect(await repository.loadCurrent('generation-1', '2026/08/13'))
        .toMatchObject({ id: 'adopted-reservation', state: 'verified' });
    });

    it('keeps the conflict current when adoption loses its revision fence', async () => {
      const repository = await create();
      const conflict = await seedBlocked(repository, '2026/08/13', 'conflict', 900);

      await expect(repository.adoptConflictCandidate({
        expected: { id: conflict.id, revision: conflict.revision + 1 },
        replacement: replacementFor(conflict, 'adopted-reservation', 'survivor-id'),
        nowMs: 1_000,
      })).resolves.toMatchObject({ kind: 'lost', current: conflict });
      expect(await repository.loadCurrent('generation-1', '2026/08/13'))
        .toEqual(conflict);
    });

    it('rolls back conflict adoption when the surviving folder ID is historical', async () => {
      const repository = await create();
      const historical = await seedBlocked(repository, '2026/08/12', 'detached', 800);
      const conflict = await seedBlocked(repository, '2026/08/13', 'conflict', 900);

      await expect(repository.adoptConflictCandidate({
        expected: { id: conflict.id, revision: conflict.revision },
        replacement: replacementFor(conflict, 'adopted-reservation', historical.folderId),
        nowMs: 1_000,
      })).resolves.toMatchObject({ kind: 'lost', current: conflict });
      expect(await repository.loadCurrent('generation-1', '2026/08/13'))
        .toEqual(conflict);
    });
  });
}

async function seedBlocked(
  repository: DriveFolderReservationRepositoryPort,
  normalizedPath: string,
  state: 'detached' | 'conflict',
  nextRevalidationAtMs: number,
  generationId = 'generation-1',
): Promise<DriveFolderReservation> {
  const suffix = `${generationId}-${normalizedPath.replaceAll('/', '-')}`;
  const segments = normalizedPath.split('/');
  const level = ['year', 'month', 'day'][segments.length - 1] as 'year' | 'month' | 'day';
  const stored = await repository.compareAndSetCurrent({
    expected: null,
    replacement: {
      id: `reservation-${suffix}`,
      installationId: 'installation-1',
      generationId,
      normalizedPath,
      level,
      segmentName: segments.at(-1)!,
      folderId: `folder-${suffix}`,
      parentFolderId: level === 'day' ? 'month-id' : 'motion-id',
    },
    nowMs: 100,
  });
  if (stored.kind !== 'stored') throw new Error('blocked fixture reservation lost');
  const verified = await repository.markVerified(stored.reservation.id, stored.reservation.revision, 200);
  if (verified === null) throw new Error('blocked fixture verification lost');
  const blocked = await repository.markBlocked(
    verified.id,
    verified.revision,
    state,
    'seeded_block',
    300,
    nextRevalidationAtMs,
  );
  if (blocked === null) throw new Error('blocked fixture transition lost');
  return blocked;
}

function replacementFor(
  conflict: DriveFolderReservation,
  id: string,
  folderId: string,
): ReserveDriveFolder {
  return {
    id,
    installationId: conflict.installationId,
    generationId: conflict.generationId,
    normalizedPath: conflict.normalizedPath,
    level: conflict.level,
    segmentName: conflict.segmentName,
    folderId,
    parentFolderId: conflict.parentFolderId,
  };
}
