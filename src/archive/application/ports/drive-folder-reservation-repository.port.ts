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
  compareAndSetCurrent(input: {
    expected: { id: string; revision: number } | null;
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<{ kind: 'stored'; reservation: DriveFolderReservation } | { kind: 'lost'; current: DriveFolderReservation | null }>;
  markVerified(id: string, expectedRevision: number, nowMs: number): Promise<DriveFolderReservation | null>;
  markBlocked(id: string, expectedRevision: number, state: 'detached' | 'conflict', errorCode: string, nowMs: number): Promise<DriveFolderReservation | null>;
  replaceMissing(input: {
    expected: { id: string; revision: number; folderId: string };
    replacement: ReserveDriveFolder;
    nowMs: number;
  }): Promise<{ kind: 'stored'; reservation: DriveFolderReservation } | { kind: 'lost'; current: DriveFolderReservation | null }>;
  countUnhealthy(generationId: string): Promise<number>;
}
