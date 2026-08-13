import type { DriveConnection } from "../../domain/drive-connection.entity";

export const DRIVE_FOLDER = Symbol("DRIVE_FOLDER");

export interface DriveFolderMetadata {
  id: string;
  name: string | null;
  mimeType: string | null;
  parentIds: readonly string[] | null;
  appProperties: Readonly<Record<string, string>> | null;
  ownedByMe: boolean | null;
  ownerPermissionIds: readonly string[] | null;
  permissionIds: readonly string[] | null;
  shared: boolean | null;
  trashed: boolean | null;
}

export interface DriveFolderListInput {
  connection: DriveConnection;
  parentId: string;
  role: "motion-year" | "motion-month" | "motion-day";
  normalizedPath: string;
  pageToken: string | null;
  pageSize: number;
}

export interface DriveFolderCreateInput {
  connection: DriveConnection;
  id: string;
  parentId: string;
  name: string;
  appProperties: Readonly<Record<string, string>>;
}

export interface DriveFolderPage {
  folders: readonly DriveFolderMetadata[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
}

export class DriveFolderPageTokenRejectedError extends Error {
  readonly code = "DRIVE_FOLDER_PAGE_TOKEN_REJECTED" as const;

  constructor() {
    super("Google Drive folder page token was rejected");
    this.name = "DriveFolderPageTokenRejectedError";
  }
}

/** Exact-ID operations must not accept a provider response for another folder. */
export class DriveFolderExactIdIntegrityError extends Error {
  readonly code = "DRIVE_FOLDER_EXACT_ID_INTEGRITY" as const;

  constructor() {
    super("Google Drive folder exact-ID integrity check failed");
    this.name = "DriveFolderExactIdIntegrityError";
  }
}

/** Provider-neutral exact-ID boundary for private motion date folders. */
export interface DriveFolderPort {
  generateId(connection: DriveConnection, signal: AbortSignal): Promise<string>;
  loadExact(connection: DriveConnection, folderId: string, signal: AbortSignal): Promise<DriveFolderMetadata | null>;
  listCandidates(input: DriveFolderListInput, signal: AbortSignal): Promise<DriveFolderPage>;
  create(input: DriveFolderCreateInput, signal: AbortSignal): Promise<DriveFolderMetadata>;
}
