import type { DriveConnection } from '../../domain/drive-connection.entity';
import type { VerifiedDriveObject } from '../../domain/drive-object-metadata.value-object';

export const DRIVE_ARCHIVE = Symbol('DRIVE_ARCHIVE');

export interface BeginResumableUpload {
  connection: DriveConnection;
  fileId: string;
  parentId: string;
  name: string;
  mimeType: string;
  size: number;
  appProperties: Readonly<Record<string, string>>;
}

export interface UploadSession {
  uri: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface UploadSessionQuery {
  connection: DriveConnection;
  uri: string;
  totalSize: number;
}

export type UploadSessionStatus =
  | { kind: 'complete' }
  | { kind: 'resume'; confirmedOffset: number }
  | { kind: 'expired' };

export interface UploadChunk {
  connection: DriveConnection;
  fileId: string;
  uri: string;
  start: number;
  endInclusive: number;
  totalSize: number;
  /** Provider-neutral byte source; Node stream types remain infrastructure-only. */
  body: AsyncIterable<Uint8Array>;
}

export type UploadChunkResult =
  | { kind: 'complete' }
  | { kind: 'resume'; confirmedOffset: number };

export interface ListManagedObjects {
  connection: DriveConnection;
  parentId: string;
  pageToken: string | null;
  pageSize: number;
}

export interface DriveObjectPage {
  objects: readonly VerifiedDriveObject[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
}

/** Exact-ID, provider-neutral boundary for immutable Drive archive objects. */
export interface DriveArchivePort {
  generateFileId(connection: DriveConnection, signal: AbortSignal): Promise<string>;
  beginResumableUpload(input: BeginResumableUpload, signal: AbortSignal): Promise<UploadSession>;
  querySession(input: UploadSessionQuery, signal: AbortSignal): Promise<UploadSessionStatus>;
  uploadChunk(input: UploadChunk, signal: AbortSignal): Promise<UploadChunkResult>;
  loadObject(connection: DriveConnection, fileId: string, signal: AbortSignal): Promise<VerifiedDriveObject | null>;
  listManagedObjects(input: ListManagedObjects, signal: AbortSignal): Promise<DriveObjectPage>;
  deleteExact(connection: DriveConnection, fileId: string, signal: AbortSignal): Promise<void>;
}
