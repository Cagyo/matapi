import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import { DrizzleDriveFolderReservationRepository } from '../../../src/archive/infrastructure/persistence/drizzle-drive-folder-reservation.repository';

describe('DrizzleDriveFolderReservationRepository', () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;
  let repository: DrizzleDriveFolderReservationRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    repository = new DrizzleDriveFolderReservationRepository(db);
  });

  afterEach(() => sqlite.close());

  it('rejects a stale current-head revision without changing history', async () => {
    const first = await repository.compareAndSetCurrent({
      expected: null,
      replacement: reservation('r1', '2026', 'f1'),
      nowMs: 10,
    });
    if (first.kind !== 'stored') throw new Error('expected first reservation');
    const result = await repository.compareAndSetCurrent({
      expected: { id: first.reservation.id, revision: first.reservation.revision + 1 },
      replacement: reservation('r2', '2026', 'f2'),
      nowMs: 20,
    });
    expect(result.kind).toBe('lost');
    expect(await repository.loadCurrent('generation-1', '2026')).toMatchObject({ folderId: 'f1' });
    expect(history()).toEqual([expect.objectContaining({ id: 'r1', revision: 0 })]);
  });

  it('allows only one null-head CAS call to store a current row', async () => {
    const [left, right] = await Promise.all([
      repository.compareAndSetCurrent({ expected: null, replacement: reservation('r1', '2026', 'f1'), nowMs: 10 }),
      repository.compareAndSetCurrent({ expected: null, replacement: reservation('r2', '2026', 'f2'), nowMs: 10 }),
    ]);
    expect([left.kind, right.kind].sort()).toEqual(['lost', 'stored']);
    expect(history()).toHaveLength(1);
    expect(await repository.loadCurrent('generation-1', '2026')).toMatchObject({ currentSlot: 1 });
  });

  it('rolls back a reused folder ID without replacing the current row', async () => {
    const first = await stored(reservation('r1', '2026', 'f1'), 10);
    const oldPath = await stored(reservation('r-old', '2025', 'reused-folder'), 10);
    const before = history();

    const result = await repository.replaceMissing({
      expected: { id: first.id, revision: first.revision, folderId: first.folderId },
      replacement: reservation('r2', '2026', oldPath.folderId),
      nowMs: 20,
    });

    expect(result).toMatchObject({ kind: 'lost', current: { id: first.id, folderId: first.folderId, revision: first.revision } });
    expect(await repository.loadCurrent('generation-1', '2026')).toMatchObject({ id: first.id, folderId: first.folderId, revision: first.revision });
    expect(history()).toEqual(before);
  });

  it('leaves the original row current when replacement insertion fails', async () => {
    const first = await stored(reservation('r1', '2026', 'f1'), 10);
    await stored(reservation('duplicate-id', '2025', 'f-old'), 10);
    const before = history();

    const result = await repository.replaceMissing({
      expected: { id: first.id, revision: first.revision, folderId: first.folderId },
      replacement: reservation('duplicate-id', '2026', 'f2'),
      nowMs: 20,
    });

    expect(result).toMatchObject({ kind: 'lost', current: { id: first.id, folderId: first.folderId, revision: first.revision } });
    expect(await repository.loadCurrent('generation-1', '2026')).toMatchObject({ id: first.id, folderId: first.folderId, revision: first.revision });
    expect(history()).toEqual(before);
  });

  it('supersedes current month and day descendants when replacing a year', async () => {
    const year = await stored(reservation('year-1', '2026', 'folder-year-1'), 10);
    await stored(reservation('month-1', '2026/08', 'folder-month-1', 'month', '08', 'folder-year-1'), 10);
    await stored(reservation('day-1', '2026/08/13', 'folder-day-1', 'day', '13', 'folder-month-1'), 10);

    const result = await repository.replaceMissing({
      expected: { id: year.id, revision: year.revision, folderId: year.folderId },
      replacement: reservation('year-2', '2026', 'folder-year-2'),
      nowMs: 20,
    });

    expect(result).toMatchObject({ kind: 'stored', reservation: { id: 'year-2', currentSlot: 1 } });
    expect(await repository.loadCurrent('generation-1', '2026/08')).toBeNull();
    expect(await repository.loadCurrent('generation-1', '2026/08/13')).toBeNull();
    expect(history()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'year-1', state: 'missing', currentSlot: null }),
      expect.objectContaining({ id: 'month-1', state: 'superseded', currentSlot: null }),
      expect.objectContaining({ id: 'day-1', state: 'superseded', currentSlot: null }),
    ]));
  });

  it('retains detached and conflict rows in the current slot', async () => {
    const detached = await stored(reservation('detached', '2026', 'f-detached'), 10);
    const conflict = await stored(reservation('conflict', '2027', 'f-conflict'), 10);

    expect(await repository.markBlocked(detached.id, detached.revision, 'detached', 'metadata_changed', 20))
      .toMatchObject({ state: 'detached', currentSlot: 1 });
    expect(await repository.markBlocked(conflict.id, conflict.revision, 'conflict', 'parent_changed', 20))
      .toMatchObject({ state: 'conflict', currentSlot: 1 });
    expect(await repository.countUnhealthy('generation-1')).toBe(2);
    expect(history()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: detached.id, state: 'detached', currentSlot: 1 }),
      expect.objectContaining({ id: conflict.id, state: 'conflict', currentSlot: 1 }),
    ]));
  });

  it('wraps verified and blocked transitions in immediate transactions', async () => {
    const immediateBehaviors: unknown[] = [];
    const instrumentedDb = new Proxy(db, {
      get(target, property) {
        if (property === 'transaction') {
          const transaction = target.transaction.bind(target);
          return (...args: Parameters<typeof transaction>) => {
            immediateBehaviors.push((args[1] as { behavior?: unknown } | undefined)?.behavior);
            return transaction(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value === 'function') {
          return (...args: never[]): unknown => Reflect.apply(value, target, args) as unknown;
        }
        return value;
      },
    });
    const instrumentedRepository = new DrizzleDriveFolderReservationRepository(instrumentedDb);
    const verified = await stored(reservation('verified', '2026', 'f-verified'), 10);
    const blocked = await stored(reservation('blocked', '2027', 'f-blocked'), 10);

    expect(await instrumentedRepository.markVerified(verified.id, verified.revision, 20))
      .toMatchObject({ state: 'verified', revision: 1 });
    expect(await instrumentedRepository.markBlocked(blocked.id, blocked.revision, 'detached', 'metadata_changed', 20))
      .toMatchObject({ state: 'detached', revision: 1, currentSlot: 1 });
    expect(immediateBehaviors).toEqual(['immediate', 'immediate']);
  });

  async function stored(input: ReturnType<typeof reservation>, nowMs: number) {
    const result = await repository.compareAndSetCurrent({ expected: null, replacement: input, nowMs });
    if (result.kind !== 'stored') throw new Error('expected stored reservation');
    return result.reservation;
  }

  function history() {
    return sqlite.prepare('SELECT id, state, current_slot AS currentSlot, revision FROM drive_motion_folder_reservations ORDER BY id').all();
  }
});

function reservation(
  id: string,
  normalizedPath: string,
  folderId: string,
  level: 'year' | 'month' | 'day' = 'year',
  segmentName = normalizedPath,
  parentFolderId = 'motion-1',
) {
  return {
    id,
    installationId: 'installation-1',
    generationId: 'generation-1',
    normalizedPath,
    level,
    segmentName,
    folderId,
    parentFolderId,
  };
}
