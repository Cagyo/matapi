import { describe, expect, it } from 'vitest';
import { InMemoryDriveFolderReservationRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-folder-reservation.repository';

describe('InMemoryDriveFolderReservationRepository', () => {
  it('lets only one concurrent reservation win the current path slot', async () => {
    const repository = new InMemoryDriveFolderReservationRepository();
    const base = {
      installationId: 'installation-1', generationId: 'generation-1',
      normalizedPath: '2026/08/13', level: 'day' as const, segmentName: '13',
      parentFolderId: 'month-1',
    };
    const [left, right] = await Promise.all([
      repository.compareAndSetCurrent({ expected: null, replacement: { ...base, id: 'r1', folderId: 'f1' }, nowMs: 10 }),
      repository.compareAndSetCurrent({ expected: null, replacement: { ...base, id: 'r2', folderId: 'f2' }, nowMs: 10 }),
    ]);
    expect([left.kind, right.kind].sort()).toEqual(['lost', 'stored']);
    expect(await repository.loadCurrent('generation-1', '2026/08/13')).not.toBeNull();
  });

  it('terminalizes a missing ancestor and supersedes its current descendants atomically', async () => {
    const repository = new InMemoryDriveFolderReservationRepository();
    const rows = [
      { id: 'year-1', normalizedPath: '2026', level: 'year' as const, segmentName: '2026', folderId: 'folder-year-1', parentFolderId: 'motion-1' },
      { id: 'month-1', normalizedPath: '2026/08', level: 'month' as const, segmentName: '08', folderId: 'folder-month-1', parentFolderId: 'folder-year-1' },
      { id: 'day-1', normalizedPath: '2026/08/13', level: 'day' as const, segmentName: '13', folderId: 'folder-day-1', parentFolderId: 'folder-month-1' },
    ];
    for (const row of rows) {
      const stored = await repository.compareAndSetCurrent({
        expected: null,
        replacement: { installationId: 'installation-1', generationId: 'generation-1', ...row },
        nowMs: 10,
      });
      if (stored.kind !== 'stored') throw new Error('expected seeded reservation');
      await repository.markVerified(stored.reservation.id, stored.reservation.revision, 11);
    }
    const current = await repository.loadCurrent('generation-1', '2026');
    if (current === null) throw new Error('expected current year');
    const replaced = await repository.replaceMissing({
      expected: { id: current.id, revision: current.revision, folderId: current.folderId },
      replacement: {
        id: 'year-2', installationId: 'installation-1', generationId: 'generation-1',
        normalizedPath: '2026', level: 'year', segmentName: '2026',
        folderId: 'folder-year-2', parentFolderId: 'motion-1',
      },
      nowMs: 20,
    });
    expect(replaced.kind).toBe('stored');
    expect(await repository.loadCurrent('generation-1', '2026/08')).toBeNull();
    const history = repository.history();
    expect(history.find((row) => row.id === 'year-1')).toMatchObject({ state: 'missing', currentSlot: null });
    expect(history.filter((row) => row.state === 'superseded')).toEqual([
      expect.objectContaining({ id: 'month-1', currentSlot: null }),
      expect.objectContaining({ id: 'day-1', currentSlot: null }),
    ]);
  });

  it('does not mutate a head or history when replacement expectations are stale', async () => {
    const repository = new InMemoryDriveFolderReservationRepository();
    const stored = await repository.compareAndSetCurrent({
      expected: null,
      replacement: reservation('year-1', '2026', 'folder-year-1'), nowMs: 10,
    });
    if (stored.kind !== 'stored') throw new Error('expected stored reservation');
    const before = repository.history();
    const lost = await repository.replaceMissing({
      expected: { id: stored.reservation.id, revision: stored.reservation.revision + 1, folderId: stored.reservation.folderId },
      replacement: reservation('year-2', '2026', 'folder-year-2'), nowMs: 20,
    });
    expect(lost).toMatchObject({ kind: 'lost', current: stored.reservation });
    expect(repository.history()).toEqual(before);
    expect(await repository.loadCurrent('generation-1', '2026')).toEqual(stored.reservation);
  });

  it('rejects reuse of a historical folder ID without mutating current state', async () => {
    const repository = new InMemoryDriveFolderReservationRepository();
    const stored = await repository.compareAndSetCurrent({
      expected: null,
      replacement: reservation('year-1', '2026', 'folder-1'), nowMs: 10,
    });
    if (stored.kind !== 'stored') throw new Error('expected stored reservation');
    const replacementSeed = await repository.replaceMissing({
      expected: { id: stored.reservation.id, revision: stored.reservation.revision, folderId: stored.reservation.folderId },
      replacement: reservation('year-2', '2026', 'folder-2'), nowMs: 15,
    });
    if (replacementSeed.kind !== 'stored') throw new Error('expected replacement seed');
    const before = repository.history();
    const normal = await repository.compareAndSetCurrent({
      expected: null,
      replacement: { ...reservation('year-2', '2027', 'folder-1'), segmentName: '2027' }, nowMs: 20,
    });
    const replacement = await repository.replaceMissing({
      expected: { id: replacementSeed.reservation.id, revision: replacementSeed.reservation.revision, folderId: replacementSeed.reservation.folderId },
      replacement: reservation('year-3', '2026', 'folder-1'), nowMs: 20,
    });
    expect(normal).toMatchObject({ kind: 'lost', current: null });
    expect(replacement).toMatchObject({ kind: 'lost', current: replacementSeed.reservation });
    expect(repository.history()).toEqual(before);
    expect(await repository.loadCurrent('generation-1', '2026')).toEqual(replacementSeed.reservation);
    expect(await repository.loadCurrent('generation-1', '2027')).toBeNull();
  });

  it('returns immutable snapshots and counts blocking current heads as unhealthy', async () => {
    const repository = new InMemoryDriveFolderReservationRepository();
    const stored = await repository.compareAndSetCurrent({
      expected: null,
      replacement: reservation('year-1', '2026', 'folder-year-1'), nowMs: 10,
    });
    if (stored.kind !== 'stored') throw new Error('expected stored reservation');
    const blocked = await repository.markBlocked(stored.reservation.id, stored.reservation.revision, 'detached', 'metadata_changed', 20);
    expect(blocked).toMatchObject({ state: 'detached', currentSlot: 1 });
    expect(await repository.countUnhealthy('generation-1')).toBe(1);
    expect(() => { (blocked as { state: string }).state = 'verified'; }).toThrow();
  });
});

function reservation(id: string, normalizedPath: string, folderId: string) {
  return {
    id, installationId: 'installation-1', generationId: 'generation-1', normalizedPath,
    level: 'year' as const, segmentName: normalizedPath, folderId, parentFolderId: 'motion-1',
  };
}
