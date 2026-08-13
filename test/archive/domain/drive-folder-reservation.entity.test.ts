import { describe, expect, it } from 'vitest';
import { DriveFolderReservation } from '../../../src/archive/domain/drive-folder-reservation.entity';

describe('DriveFolderReservation', () => {
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
