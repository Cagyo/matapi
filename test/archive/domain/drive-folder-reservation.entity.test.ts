import { describe, expect, it } from 'vitest';
import { DriveFolderReservation } from '../../../src/archive/domain/drive-folder-reservation.entity';

describe('DriveFolderReservation', () => {
  it('restores only a current detached head through a revisioned revalidation', () => {
    const blocked = DriveFolderReservation.reserve({
      id: 'reservation-1', installationId: 'installation-1', generationId: 'generation-1',
      normalizedPath: '2026/08/13', level: 'day', segmentName: '13',
      folderId: 'folder-1', parentFolderId: 'month-1', nowMs: 100,
    })
      .verify(110)
      .block('detached', 'DRIVE_FOLDER_BRANCH_BLOCKED', 120, 900_000);

    expect(blocked.restoreAfterRevalidation(130)).toMatchObject({
      state: 'verified',
      revalidationFailureStreak: 0,
      nextRevalidationAtMs: null,
      errorCode: null,
      revision: 3,
    });
  });

  it('advances a failed blocked-head probe without changing its identity', () => {
    const blocked = DriveFolderReservation.reserve({
      id: 'reservation-1', installationId: 'installation-1', generationId: 'generation-1',
      normalizedPath: '2026/08/13', level: 'day', segmentName: '13',
      folderId: 'folder-1', parentFolderId: 'month-1', nowMs: 100,
    }).block('conflict', 'DRIVE_FOLDER_BRANCH_BLOCKED', 120, 900_000);

    expect(blocked.rescheduleRevalidation('branch_still_conflicting', 130, 1_800_000))
      .toMatchObject({
        state: 'conflict',
        folderId: 'folder-1',
        revalidationFailureStreak: 2,
        nextRevalidationAtMs: 1_800_000,
        errorCode: 'branch_still_conflicting',
      });
  });

  it('moves reserved to verified through a CAS revision', () => {
    const reserved = DriveFolderReservation.reserve({
      id: 'reservation-1', installationId: 'installation-1', generationId: 'generation-1',
      normalizedPath: '2026/08/13', level: 'day', segmentName: '13',
      folderId: 'folder-1', parentFolderId: 'month-1', nowMs: 100,
    });
    expect(reserved.verify(110)).toMatchObject({ state: 'verified', revision: 1, verifiedAtMs: 110 });
  });

  it.each(['detached', 'conflict'] as const)('keeps %s as a blocking current head', (state) => {
    const reserved = DriveFolderReservation.reserve({
      id: 'reservation-1', installationId: 'installation-1', generationId: 'generation-1',
      normalizedPath: '2026', level: 'year', segmentName: '2026',
      folderId: 'folder-1', parentFolderId: 'motion-1', nowMs: 100,
    });
    expect(reserved.block(state, 'metadata_changed', 110)).toMatchObject({ state, currentSlot: 1 });
  });
});
