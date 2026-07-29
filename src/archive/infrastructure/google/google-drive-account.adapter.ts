import type {
  DriveAccountIdentity,
  DriveAccountPort,
  DriveQuota,
  ManagedDriveFolders,
} from "../../application/ports/drive-account.port";
import type { DriveCredentialRepositoryPort, ManagedFolderReservation } from "../../application/ports/drive-credential-repository.port";
import type { DriveConnection } from "../../domain/drive-connection.entity";
import { DriveFolderAmbiguousError } from "../../domain/errors/drive-folder-ambiguous.error";
import { DriveObjectConflictError } from "../../domain/errors/drive-object-conflict.error";
import {
  GoogleDriveGateway,
  GoogleDrivePageTokenRejectedError,
  mapGoogleDriveFailure,
  type GoogleDriveFolder,
  type GoogleDriveFolderRole,
} from "./google-drive.gateway";

const ROOT_PARENT_ID = "root";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/** Resolves account state and private managed folders from exact Google Drive metadata. */
export class GoogleDriveAccountAdapter implements DriveAccountPort {
  constructor(
    private readonly drive: GoogleDriveGateway,
    private readonly generations: Pick<DriveCredentialRepositoryPort, "loadManagedFolderReservation" | "reserveManagedFolder">,
  ) {}

  async resolveAccount(connection: DriveConnection, signal: AbortSignal): Promise<DriveAccountIdentity> {
    const about = await this.callDrive(() => this.drive.loadAbout(signal));
    const permissionId = about.user?.permissionId;
    if (!isText(permissionId)) {
      throw new DriveFolderAmbiguousError("Google Drive account permission ID is missing");
    }
    if (connection.permissionId !== null && connection.permissionId !== permissionId) {
      throw new DriveFolderAmbiguousError("Google Drive account does not match this connection generation");
    }
    return {
      permissionId,
      email: about.user?.emailAddress ?? null,
      displayName: about.user?.displayName ?? null,
    };
  }

  async readQuota(_connection: DriveConnection, signal: AbortSignal): Promise<DriveQuota> {
    const about = await this.callDrive(() => this.drive.loadAbout(signal));
    const quota = about.storageQuota;
    if (quota === null) throw new DriveFolderAmbiguousError("Google Drive storage quota is missing");
    const usageBytes = parseInt64(quota.usage, "usage");
    const usageInDriveBytes = parseInt64(quota.usageInDrive, "usageInDrive");
    const usageInDriveTrashBytes = parseInt64(quota.usageInDriveTrash, "usageInDriveTrash");
    const limitBytes = quota.limit === null ? null : parseInt64(quota.limit, "limit");
    if (usageBytes < usageInDriveBytes + usageInDriveTrashBytes || (limitBytes !== null && limitBytes < usageBytes)) {
      throw new DriveFolderAmbiguousError("Google Drive storage quota is inconsistent");
    }
    return { limitBytes, usageBytes, usageInDriveBytes, usageInDriveTrashBytes };
  }

  async resolveManagedFolders(connection: DriveConnection, signal: AbortSignal): Promise<ManagedDriveFolders> {
    const account = await this.resolveAccount(connection, signal);
    const reservation = await this.generations.loadManagedFolderReservation(connection.id);
    const state: FolderResolutionState = {
      reservation,
      expectedRevision: reservation?.revision ?? connection.revision,
    };
    const rootId = await this.resolveFolder({
      connection,
      accountPermissionId: account.permissionId,
      role: "root",
      parentId: ROOT_PARENT_ID,
      storedId: connection.folders?.rootId ?? reservation?.rootId ?? null,
      signal,
      state,
    });
    const motionId = await this.resolveFolder({
      connection,
      accountPermissionId: account.permissionId,
      role: "motion",
      parentId: rootId,
      storedId: connection.folders?.motionId ?? reservation?.motionId ?? null,
      signal,
      state,
    });
    const backupsId = await this.resolveFolder({
      connection,
      accountPermissionId: account.permissionId,
      role: "backups",
      parentId: rootId,
      storedId: connection.folders?.backupsId ?? reservation?.backupsId ?? null,
      signal,
      state,
    });
    return { rootId, motionId, backupsId };
  }

  private async resolveFolder(input: ResolveFolderInput): Promise<string> {
    if (input.storedId !== null) {
      const stored = await this.callDrive(() => this.drive.loadFolder(input.storedId!, input.signal));
      if (stored !== null && isExpectedFolder(stored, input)) return stored.id;
    }

    const candidates = await this.findCandidates(input);
    if (candidates.length > 1) {
      throw new DriveFolderAmbiguousError("Several Google Drive folders match one managed role");
    }
    if (candidates.length === 1) return candidates[0].id;

    const id = await this.callDrive(() => this.drive.generateFolderId(input.signal));
    const reservation = await this.generations.reserveManagedFolder({
      generationId: input.connection.id,
      expectedRevision: input.state.expectedRevision,
      role: input.role,
      folderId: id,
    });
    if (reservation === null) throw new DriveObjectConflictError("Drive folder reservation changed before creation");
    input.state.reservation = reservation;
    input.state.expectedRevision = reservation.revision;
    const create = {
      id,
      name: folderName(input.role),
      role: input.role,
      parentId: input.parentId,
      appProperties: folderProperties(input.connection, input.role),
      signal: input.signal,
    };
    try {
      const created = await this.callDrive(() => this.drive.createFolder(create));
      if (!isExpectedFolder(created, input)) {
        throw new DriveFolderAmbiguousError("Google Drive created folder metadata is not private and exact");
      }
      return created.id;
    } catch (error) {
      if (error instanceof DriveFolderAmbiguousError) throw error;
      const recovered = await this.callDrive(() => this.drive.loadFolder(id, input.signal));
      if (recovered !== null && isExpectedFolder(recovered, input)) return recovered.id;
      throw error;
    }
  }

  private async findCandidates(input: ResolveFolderInput): Promise<GoogleDriveFolder[]> {
    const candidates: GoogleDriveFolder[] = [];
    let pageToken: string | null = null;
    let restarted = false;
    for (;;) {
      let page;
      try {
        page = await this.drive.listFolders({
          installationId: input.connection.installationId,
          generationId: input.connection.id,
          role: input.role,
          parentId: input.parentId,
          pageToken,
          signal: input.signal,
        });
      } catch (error) {
        if (!restarted && (error instanceof GoogleDrivePageTokenRejectedError || isRejectedPageToken(error))) {
          restarted = true;
          pageToken = null;
          candidates.length = 0;
          continue;
        }
        throw mapGoogleDriveFailure(error);
      }
      if (page.incompleteSearch) {
        throw new DriveFolderAmbiguousError("Google Drive folder search was incomplete");
      }
      candidates.push(...page.files.filter((file) => isExpectedFolder(file, input)));
      if (page.nextPageToken === null) return candidates;
      pageToken = page.nextPageToken;
    }
  }

  private async callDrive<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapGoogleDriveFailure(error);
    }
  }
}

interface ResolveFolderInput {
  connection: DriveConnection;
  accountPermissionId: string;
  role: GoogleDriveFolderRole;
  parentId: string;
  storedId: string | null;
  signal: AbortSignal;
  state: FolderResolutionState;
}

interface FolderResolutionState {
  reservation: ManagedFolderReservation | null;
  expectedRevision: number;
}

function isExpectedFolder(file: GoogleDriveFolder, input: ResolveFolderInput): boolean {
  return isText(file.id)
    && file.mimeType === FOLDER_MIME_TYPE
    && file.trashed === false
    && file.driveId === null
    && file.ownedByMe === true
    && file.shared === false
    && sameOnlyValue(file.parents, input.parentId)
    && file.owners !== null
    && file.owners.length === 1
    && file.owners[0].permissionId === input.accountPermissionId
    && sameOnlyValue(file.permissionIds, input.accountPermissionId)
    && hasExpectedProperties(file.appProperties, input.connection, input.role);
}

function hasExpectedProperties(
  properties: Readonly<Record<string, string>> | null,
  connection: DriveConnection,
  role: GoogleDriveFolderRole,
): boolean {
  if (properties === null) return false;
  return Object.entries(folderProperties(connection, role)).every(([key, value]) => properties[key] === value);
}

function folderProperties(connection: DriveConnection, role: GoogleDriveFolderRole): Readonly<Record<string, string>> {
  return { a1v: "1", a1i: connection.installationId, a1g: connection.id, a1k: role };
}

function folderName(role: GoogleDriveFolderRole): string {
  switch (role) {
    case "root": return "Home Worker Archive";
    case "motion": return "Motion";
    case "backups": return "Backups";
  }
}

function parseInt64(value: string | null, name: string): number {
  if (!isText(value) || !/^\d+$/u.test(value)) {
    throw new DriveFolderAmbiguousError(`Google Drive storage quota ${name} is malformed`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DriveFolderAmbiguousError(`Google Drive storage quota ${name} is outside the supported range`);
  }
  return parsed;
}

function sameOnlyValue(values: readonly string[] | null, expected: string): boolean {
  return values !== null && values.length === 1 && values[0] === expected;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRejectedPageToken(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const response = (value as { response?: unknown }).response;
  if (typeof response !== "object" || response === null || (response as { status?: unknown }).status !== 400) return false;
  const message = (response as { data?: { error?: { message?: unknown } } }).data?.error?.message;
  return typeof message === "string" && /page\s*token/iu.test(message);
}
