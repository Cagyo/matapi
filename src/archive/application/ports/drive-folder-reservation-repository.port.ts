import type {
  DriveFolderReservation,
  DriveFolderReservationSnapshot,
} from '../../domain/drive-folder-reservation.entity';

export const DRIVE_FOLDER_RESERVATION_REPOSITORY = Symbol('DRIVE_FOLDER_RESERVATION_REPOSITORY');

export type ReserveDriveFolder = Pick<DriveFolderReservationSnapshot,
  'id' | 'installationId' | 'generationId' | 'normalizedPath' | 'level' |
  'segmentName' | 'folderId' | 'parentFolderId'>;

export interface DriveFolderReservationRepositoryPort {
  loadCurrent(generationId: string, normalizedPath: string): Promise<DriveFolderReservation | null>;
  claimNextBlockedRevalidation(input: {
    generationId: string;
    nowMs: number;
    claimUntilMs: number;
  }): Promise<DriveFolderReservation | null>;
  requestNextBlockedRevalidation(input: {
    generationId: string;
    nowMs: number;
  }): Promise<DriveFolderReservation | null>;
  restoreDetached(
    id: string,
    expectedRevision: number,
    nowMs: number,
  ): Promise<DriveFolderReservation | null>;
  adoptConflictCandidate(input: {
    expected: { id: string; revision: number };
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<
    | { kind: 'stored'; reservation: DriveFolderReservation }
    | { kind: 'lost'; current: DriveFolderReservation | null }
  >;
  rescheduleBlockedRevalidation(input: {
    id: string;
    expectedRevision: number;
    errorCode: string;
    nowMs: number;
    nextRevalidationAtMs: number;
  }): Promise<DriveFolderReservation | null>;
  compareAndSetCurrent(input: {
    expected: { id: string; revision: number } | null;
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<{ kind: 'stored'; reservation: DriveFolderReservation } | { kind: 'lost'; current: DriveFolderReservation | null }>;
  appendMissingIdentity(input: {
    reservation: ReserveDriveFolder;
    nowMs: number;
  }): Promise<'stored' | 'exists'>;
  markVerified(id: string, expectedRevision: number, nowMs: number): Promise<DriveFolderReservation | null>;
  markBlocked(
    id: string,
    expectedRevision: number,
    state: 'detached' | 'conflict',
    errorCode: string,
    nowMs: number,
    nextRevalidationAtMs?: number | null,
  ): Promise<DriveFolderReservation | null>;
  replaceMissing(input: {
    expected: { id: string; revision: number; folderId: string };
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<{ kind: 'stored'; reservation: DriveFolderReservation } | { kind: 'lost'; current: DriveFolderReservation | null }>;
  countUnhealthy(generationId: string): Promise<number>;
}
