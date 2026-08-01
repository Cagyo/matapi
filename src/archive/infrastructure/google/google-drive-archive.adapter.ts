import { auth, drive as googleDrive, type drive_v3 } from '@googleapis/drive';
import { Inject, Injectable } from '@nestjs/common';
import type {
  BeginResumableUpload,
  DriveArchivePort,
  DriveObjectPage,
  ListManagedObjects,
  UploadChunk,
  UploadChunkResult,
  UploadSession,
  UploadSessionQuery,
  UploadSessionStatus,
} from '../../application/ports/drive-archive.port';
import {
  DRIVE_CREDENTIAL_REPOSITORY,
  type DriveCredentialRepositoryPort,
} from '../../application/ports/drive-credential-repository.port';
import type { DriveConnection } from '../../domain/drive-connection.entity';
import type { VerifiedDriveObject } from '../../domain/drive-object-metadata.value-object';
import { DriveConfigurationError } from '../../domain/errors/drive-configuration.error';
import { DriveObjectConflictError } from '../../domain/errors/drive-object-conflict.error';
import { GoogleResumableUploadGateway } from './google-resumable-upload.gateway';
import { mapGoogleDriveFailure } from './google-drive.gateway';

const OBJECT_FIELDS = [
  'id', 'name', 'parents', 'mimeType', 'size', 'sha256Checksum', 'md5Checksum',
  'createdTime', 'headRevisionId', 'version', 'ownedByMe', 'capabilities(canDelete)',
  'trashed', 'appProperties', 'owners(permissionId)', 'permissionIds', 'shared', 'webViewLink',
].join(',');

interface ConnectionClient {
  drive: drive_v3.Drive;
  authorization(): Promise<string>;
}

/** Google SDK metadata adapter plus direct-HTTPS resumable byte transport. */
@Injectable()
export class GoogleDriveArchiveAdapter implements DriveArchivePort {
  constructor(
    @Inject(DRIVE_CREDENTIAL_REPOSITORY)
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'loadCredentials'>,
    private readonly resumable: GoogleResumableUploadGateway = new GoogleResumableUploadGateway(),
  ) {}

  async generateFileId(connection: DriveConnection, signal: AbortSignal): Promise<string> {
    const client = await this.forConnection(connection);
    try {
      const response = await client.drive.files.generateIds({ count: 1, space: 'drive', fields: 'ids' }, { signal });
      const ids = response.data.ids;
      if (!Array.isArray(ids) || ids.length !== 1 || !isText(ids[0])) {
        throw new DriveConfigurationError('Google Drive did not reserve exactly one object ID');
      }
      return ids[0];
    } catch (error) {
      throw mapObjectFailure(error);
    }
  }

  async beginResumableUpload(input: BeginResumableUpload, signal: AbortSignal): Promise<UploadSession> {
    const client = await this.forConnection(input.connection);
    try {
      return await this.resumable.begin({
        authorization: await client.authorization(),
        fileId: input.fileId,
        parentId: input.parentId,
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        appProperties: input.appProperties,
      }, signal);
    } catch (error) {
      throw mapObjectFailure(error);
    }
  }

  async querySession(input: UploadSessionQuery, signal: AbortSignal): Promise<UploadSessionStatus> {
    const client = await this.forConnection(input.connection);
    try {
      return await this.resumable.querySession({
        authorization: await client.authorization(), uri: input.uri, totalSize: input.totalSize,
      }, signal);
    } catch (error) {
      throw mapObjectFailure(error);
    }
  }

  async uploadChunk(input: UploadChunk, signal: AbortSignal): Promise<UploadChunkResult> {
    const client = await this.forConnection(input.connection);
    try {
      return await this.resumable.uploadChunk({
        authorization: await client.authorization(),
        uri: input.uri,
        fileId: input.fileId,
        start: input.start,
        endInclusive: input.endInclusive,
        totalSize: input.totalSize,
        body: input.body,
      }, signal);
    } catch (error) {
      throw mapObjectFailure(error);
    }
  }

  async loadObject(connection: DriveConnection, fileId: string, signal: AbortSignal): Promise<VerifiedDriveObject | null> {
    const client = await this.forConnection(connection);
    try {
      const response = await client.drive.files.get({ fileId, fields: OBJECT_FIELDS }, { signal });
      return toVerifiedObject(response.data);
    } catch (error) {
      if (providerStatus(error) === 404) return null;
      throw mapObjectFailure(error);
    }
  }

  async listManagedObjects(input: ListManagedObjects, signal: AbortSignal): Promise<DriveObjectPage> {
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 1_000) {
      throw new DriveConfigurationError('Google Drive object page size is invalid');
    }
    const client = await this.forConnection(input.connection);
    try {
      const response = await client.drive.files.list({
        corpora: 'user',
        spaces: 'drive',
        pageSize: input.pageSize,
        pageToken: input.pageToken ?? undefined,
        q: `'${escapeQuery(input.parentId)}' in parents and trashed=false`,
        fields: `nextPageToken,incompleteSearch,files(${OBJECT_FIELDS})`,
      }, { signal });
      return {
        objects: (response.data.files ?? []).map(toVerifiedObject),
        nextPageToken: nullableText(response.data.nextPageToken),
        incompleteSearch: response.data.incompleteSearch === true,
      };
    } catch (error) {
      throw mapObjectFailure(error);
    }
  }

  async deleteExact(connection: DriveConnection, fileId: string, signal: AbortSignal): Promise<void> {
    const client = await this.forConnection(connection);
    try {
      await client.drive.files.delete({ fileId }, { signal });
    } catch (error) {
      if (providerStatus(error) === 404) return;
      throw mapObjectFailure(error);
    }
  }

  private async forConnection(connection: DriveConnection): Promise<ConnectionClient> {
    const material = await this.credentials.loadCredentials(connection.id);
    if (material === null) throw new DriveConfigurationError('Drive connection credentials are unavailable');
    const oauth = new auth.OAuth2(material.client.clientId, material.client.clientSecret);
    oauth.setCredentials({
      access_token: material.tokens.accessToken,
      refresh_token: material.tokens.refreshToken,
      expiry_date: material.tokens.expiryDateMs,
      token_type: material.tokens.tokenType,
      scope: material.tokens.scope ?? undefined,
    });
    return {
      drive: googleDrive({ version: 'v3', auth: oauth }),
      authorization: async () => {
        const value = (await oauth.getRequestHeaders()).get('authorization');
        if (!isText(value)) throw new DriveConfigurationError('Google authorization header is unavailable');
        return value;
      },
    };
  }
}

function toVerifiedObject(file: drive_v3.Schema$File): VerifiedDriveObject {
  const parents = file.parents?.filter(isText) ?? [];
  const owners = file.owners?.map((owner) => nullableText(owner.permissionId)).filter(isText) ?? [];
  const permissionIds = [...(file.permissionIds?.filter(isText) ?? [])].sort(compareText);
  const size = parseSafeInteger(file.size, 'size');
  const createdTimeMs = parseTime(file.createdTime);
  const appProperties = file.appProperties === undefined || file.appProperties === null
    ? {}
    : Object.fromEntries(Object.entries(file.appProperties).filter((entry): entry is [string, string] => isText(entry[0]) && typeof entry[1] === 'string'));
  return {
    id: requiredText(file.id, 'ID'),
    name: requiredText(file.name, 'name'),
    parentId: parents.length === 1 ? parents[0] : '',
    mimeType: requiredText(file.mimeType, 'MIME type'),
    size,
    sha256: requiredText(file.sha256Checksum, 'SHA-256').toLowerCase(),
    md5: nullableText(file.md5Checksum)?.toLowerCase() ?? null,
    createdTimeMs,
    headRevisionId: requiredText(file.headRevisionId, 'head revision'),
    version: requiredText(file.version, 'version'),
    ownedByMe: file.ownedByMe === true,
    canDelete: file.capabilities?.canDelete === true,
    trashed: file.trashed === true,
    appProperties,
    sharing: {
      ownerPermissionId: owners.length === 1 ? owners[0] : '',
      shared: file.shared === true,
      permissionIds,
    },
    webViewLink: nullableText(file.webViewLink),
  };
}

function mapObjectFailure(error: unknown): Error {
  if (error instanceof DriveObjectConflictError || error instanceof DriveConfigurationError) return error;
  if (providerStatus(error) === 409 || providerReason(error) === 'fileIdNotUnique') {
    return new DriveObjectConflictError('Reserved Google Drive object ID conflicts');
  }
  return mapGoogleDriveFailure(error);
}

function providerStatus(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const response = (value as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null) return null;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function providerReason(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const response = (value as { response?: { data?: { error?: { reason?: unknown; errors?: { reason?: unknown }[] } } } }).response;
  const error = response?.data?.error;
  const reason = typeof error?.reason === 'string' ? error.reason : error?.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason : null;
}

function parseSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new DriveObjectConflictError(`Google Drive ${label} is malformed`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DriveObjectConflictError(`Google Drive ${label} is malformed`);
  return parsed;
}

function parseTime(value: unknown): number {
  if (!isText(value)) throw new DriveObjectConflictError('Google Drive creation time is malformed');
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DriveObjectConflictError('Google Drive creation time is malformed');
  return parsed;
}

function requiredText(value: unknown, label: string): string {
  if (!isText(value)) throw new DriveObjectConflictError(`Google Drive ${label} is missing`);
  return value;
}

function nullableText(value: unknown): string | null {
  return isText(value) ? value : null;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeQuery(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}
