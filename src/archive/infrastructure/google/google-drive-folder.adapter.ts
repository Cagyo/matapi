import { auth, drive } from "@googleapis/drive";
import { Inject, Injectable } from "@nestjs/common";
import {
  DRIVE_CREDENTIAL_REPOSITORY,
  type DriveCredentialRepositoryPort,
} from "../../application/ports/drive-credential-repository.port";
import {
  type DriveFolderCreateInput,
  type DriveFolderListInput,
  type DriveFolderMetadata,
  type DriveFolderPage,
  type DriveFolderPort,
  DriveFolderExactIdIntegrityError,
  DriveFolderPageTokenRejectedError,
} from "../../application/ports/drive-folder.port";
import type { DriveConnection } from "../../domain/drive-connection.entity";
import { DriveConfigurationError } from "../../domain/errors/drive-configuration.error";
import {
  GoogleDriveGateway,
  GoogleDrivePageTokenRejectedError,
  mapGoogleDriveFailure,
  type GoogleDriveFolder,
} from "./google-drive.gateway";

/** Authenticates a requested generation and maps Google metadata to the folder port. */
@Injectable()
export class GoogleDriveFolderAdapter implements DriveFolderPort {
  constructor(
    @Inject(DRIVE_CREDENTIAL_REPOSITORY)
    private readonly credentials: Pick<DriveCredentialRepositoryPort, "loadCredentials">,
  ) {}

  async generateId(connection: DriveConnection, signal: AbortSignal): Promise<string> {
    return this.callDrive(() => this.forConnection(connection).then((gateway) => gateway.generateFolderId(signal)));
  }

  async loadExact(
    connection: DriveConnection,
    folderId: string,
    signal: AbortSignal,
  ): Promise<DriveFolderMetadata | null> {
    const file = await this.callDrive(() => this.forConnection(connection).then((gateway) => gateway.loadFolder(folderId, signal)));
    if (file !== null) assertExactFolderId(file, folderId);
    return file === null ? null : toFolderMetadata(file);
  }

  async listCandidates(input: DriveFolderListInput, signal: AbortSignal): Promise<DriveFolderPage> {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1_000) {
      throw new DriveConfigurationError("Google Drive folder page size is invalid");
    }
    try {
      const gateway = await this.forConnection(input.connection);
      const page = await gateway.listFolders({
        installationId: input.connection.installationId,
        generationId: input.connection.id,
        scope: input.scope,
        role: input.role,
        normalizedPath: input.normalizedPath,
        parentId: input.parentId,
        pageToken: input.pageToken,
        pageSize: input.pageSize,
        signal,
      });
      return {
        folders: page.files.map(toFolderMetadata),
        nextPageToken: page.nextPageToken,
        incompleteSearch: page.incompleteSearch,
      };
    } catch (error) {
      if (error instanceof GoogleDrivePageTokenRejectedError) {
        throw new DriveFolderPageTokenRejectedError();
      }
      throw mapGoogleDriveFailure(error);
    }
  }

  async create(input: DriveFolderCreateInput, signal: AbortSignal): Promise<DriveFolderMetadata> {
    const file = await this.callDrive(() => this.forConnection(input.connection).then((gateway) => gateway.createFolder({
      id: input.id,
      name: input.name,
      role: inferDateFolderRole(input.appProperties),
      parentId: input.parentId,
      appProperties: input.appProperties,
      signal,
    })));
    assertExactFolderId(file, input.id);
    return toFolderMetadata(file);
  }

  private async forConnection(connection: DriveConnection): Promise<GoogleDriveGateway> {
    const material = await this.credentials.loadCredentials(connection.id);
    if (material === null) throw new DriveConfigurationError("Drive connection credentials are unavailable");
    const oauth = new auth.OAuth2(material.client.clientId, material.client.clientSecret);
    oauth.setCredentials({
      access_token: material.tokens.accessToken,
      refresh_token: material.tokens.refreshToken,
      expiry_date: material.tokens.expiryDateMs,
      token_type: material.tokens.tokenType,
      scope: material.tokens.scope ?? undefined,
    });
    return new GoogleDriveGateway(drive({ version: "v3", auth: oauth }));
  }

  private async callDrive<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapGoogleDriveFailure(error);
    }
  }
}

function assertExactFolderId(file: GoogleDriveFolder, expectedId: string): void {
  if (file.id !== expectedId) throw new DriveFolderExactIdIntegrityError();
}

function toFolderMetadata(file: GoogleDriveFolder): DriveFolderMetadata {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parentIds: file.parents,
    appProperties: file.appProperties,
    ownedByMe: file.ownedByMe,
    ownerPermissionIds: file.owners === null ? null : file.owners.map((owner) => owner.permissionId).filter(isText),
    permissionIds: file.permissionIds,
    shared: file.shared,
    trashed: file.trashed,
  };
}

function inferDateFolderRole(properties: Readonly<Record<string, string>>): "motion-year" | "motion-month" | "motion-day" {
  const role = properties.a1k;
  if (role === "motion-year" || role === "motion-month" || role === "motion-day") return role;
  throw new DriveConfigurationError("Google Drive date folder role is invalid");
}

function isText(value: string | null): value is string {
  return value !== null && value.length > 0;
}
