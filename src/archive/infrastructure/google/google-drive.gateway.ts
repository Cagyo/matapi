import type { drive_v3 } from "@googleapis/drive";
import { DriveConfigurationError } from "../../domain/errors/drive-configuration.error";
import { DriveFolderAmbiguousError } from "../../domain/errors/drive-folder-ambiguous.error";
import { DrivePolicyBlockedError } from "../../domain/errors/drive-policy-blocked.error";
import { DriveQuotaExceededError } from "../../domain/errors/drive-quota-exceeded.error";
import { DriveRateLimitedError } from "../../domain/errors/drive-rate-limited.error";
import { DriveReauthorizationRequiredError } from "../../domain/errors/drive-reauthorization-required.error";
import { DriveTemporaryUnavailableError } from "../../domain/errors/drive-temporary-unavailable.error";
import { DriveProviderCapacityBlockedError } from "../../domain/errors/drive-provider-capacity-blocked.error";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const FOLDER_FIELDS = "id,name,mimeType,parents,appProperties,driveId,ownedByMe,owners(permissionId),permissionIds,shared,trashed";

export type GoogleDriveFolderRole = "root" | "motion" | "backups";
export type GoogleDriveDateFolderRole = "motion-year" | "motion-month" | "motion-day";
export type GoogleDriveFolderQueryRole = GoogleDriveFolderRole | GoogleDriveDateFolderRole;

export interface GoogleDriveAbout {
  user: {
    permissionId: string | null;
    emailAddress: string | null;
    displayName: string | null;
  } | null;
  storageQuota: {
    limit: string | null;
    usage: string | null;
    usageInDrive: string | null;
    usageInDriveTrash: string | null;
  } | null;
}

export interface GoogleDriveFolder {
  id: string;
  name: string | null;
  mimeType: string | null;
  parents: readonly string[] | null;
  appProperties: Readonly<Record<string, string>> | null;
  driveId: string | null;
  ownedByMe: boolean | null;
  owners: readonly { permissionId: string | null }[] | null;
  permissionIds: readonly string[] | null;
  shared: boolean | null;
  trashed: boolean | null;
}

export interface GoogleDriveFolderPage {
  files: readonly GoogleDriveFolder[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
}

export interface GoogleDriveManagedFolderList {
  installationId: string;
  generationId: string;
  role: GoogleDriveFolderRole;
  parentId: string;
  pageToken: string | null;
  pageSize?: number;
  signal: AbortSignal;
}

export interface GoogleDriveDateFolderList {
  installationId: string;
  generationId: string;
  role: GoogleDriveDateFolderRole;
  normalizedPath: string;
  parentId: string;
  pageToken: string | null;
  pageSize: number;
  signal: AbortSignal;
}

export type GoogleDriveFolderList = GoogleDriveManagedFolderList | GoogleDriveDateFolderList;

export interface GoogleDriveFolderCreate {
  id: string;
  name: string;
  role: GoogleDriveFolderQueryRole;
  parentId: string;
  appProperties: Readonly<Record<string, string>>;
  signal: AbortSignal;
}

/** Internal-only signal that lets the adapter restart a rejected list token once. */
export class GoogleDrivePageTokenRejectedError extends Error {
  constructor() {
    super("Google Drive page token was rejected");
    this.name = "GoogleDrivePageTokenRejectedError";
  }
}

/** Narrow Google SDK boundary; application code never sees SDK resource types. */
export class GoogleDriveGateway {
  constructor(private readonly drive: drive_v3.Drive) {}

  async loadAbout(signal: AbortSignal): Promise<GoogleDriveAbout> {
    try {
      const response = await this.drive.about.get(
        { fields: "user(permissionId,emailAddress,displayName),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)" },
        { signal },
      );
      const user = response.data.user;
      const quota = response.data.storageQuota;
      return {
        user: user === undefined || user === null ? null : {
          permissionId: nullableText(user.permissionId),
          emailAddress: nullableText(user.emailAddress),
          displayName: nullableText(user.displayName),
        },
        storageQuota: quota === undefined || quota === null ? null : {
          limit: nullableText(quota.limit),
          usage: nullableText(quota.usage),
          usageInDrive: nullableText(quota.usageInDrive),
          usageInDriveTrash: nullableText(quota.usageInDriveTrash),
        },
      };
    } catch (error) {
      throw mapGoogleDriveFailure(error);
    }
  }

  async loadFolder(id: string, signal: AbortSignal): Promise<GoogleDriveFolder | null> {
    try {
      const response = await this.drive.files.get({ fileId: id, fields: FOLDER_FIELDS }, { signal });
      return toFolder(response.data);
    } catch (error) {
      if (providerStatus(error) === 404) return null;
      throw mapGoogleDriveFailure(error);
    }
  }

  async listFolders(input: GoogleDriveFolderList): Promise<GoogleDriveFolderPage> {
    try {
      const response = await this.drive.files.list({
        corpora: "user",
        spaces: "drive",
        pageSize: input.pageSize,
        pageToken: input.pageToken ?? undefined,
        q: folderQuery(input),
        fields: `nextPageToken,incompleteSearch,files(${FOLDER_FIELDS})`,
      }, { signal: input.signal });
      return {
        files: (response.data.files ?? []).map(toFolder),
        nextPageToken: nullableText(response.data.nextPageToken),
        incompleteSearch: response.data.incompleteSearch === true,
      };
    } catch (error) {
      if (isRejectedPageToken(error)) throw new GoogleDrivePageTokenRejectedError();
      throw mapGoogleDriveFailure(error);
    }
  }

  async generateFolderId(signal: AbortSignal): Promise<string> {
    try {
      const response = await this.drive.files.generateIds({ count: 1, space: "drive", fields: "ids" }, { signal });
      const ids = response.data.ids;
      if (!Array.isArray(ids) || ids.length !== 1 || !isText(ids[0])) {
        throw new DriveFolderAmbiguousError("Google Drive did not reserve exactly one folder ID");
      }
      return ids[0];
    } catch (error) {
      throw mapGoogleDriveFailure(error);
    }
  }

  async createFolder(input: GoogleDriveFolderCreate): Promise<GoogleDriveFolder> {
    try {
      const response = await this.drive.files.create({
        ignoreDefaultVisibility: true,
        fields: FOLDER_FIELDS,
        requestBody: {
          id: input.id,
          name: input.name,
          mimeType: FOLDER_MIME_TYPE,
          parents: [input.parentId],
          appProperties: { ...input.appProperties },
        },
      }, { signal: input.signal });
      return toFolder(response.data);
    } catch (error) {
      throw mapGoogleDriveFailure(error);
    }
  }
}

function folderQuery(input: GoogleDriveFolderList): string {
  const properties: Record<string, string> = {
    a1v: "1",
    a1i: input.installationId,
    a1g: input.generationId,
    a1k: input.role,
  };
  if ("normalizedPath" in input) properties.a1p = input.normalizedPath;
  const matches = Object.entries(properties).map(
    ([key, value]) => `appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`,
  );
  return [
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    `'${escapeQuery(input.parentId)}' in parents`,
    ...matches,
  ].join(" and ");
}

function toFolder(file: drive_v3.Schema$File): GoogleDriveFolder {
  return {
    id: textOrEmpty(file.id),
    name: nullableText(file.name),
    mimeType: nullableText(file.mimeType),
    parents: file.parents === undefined || file.parents === null ? null : file.parents.filter(isText),
    appProperties: file.appProperties === undefined || file.appProperties === null ? null : copyProperties(file.appProperties),
    driveId: nullableText(file.driveId),
    ownedByMe: typeof file.ownedByMe === "boolean" ? file.ownedByMe : null,
    owners: file.owners === undefined || file.owners === null ? null : file.owners.map((owner) => ({ permissionId: nullableText(owner.permissionId) })),
    permissionIds: file.permissionIds === undefined || file.permissionIds === null ? null : file.permissionIds.filter(isText),
    shared: typeof file.shared === "boolean" ? file.shared : null,
    trashed: typeof file.trashed === "boolean" ? file.trashed : null,
  };
}

function copyProperties(properties: Record<string, string>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(properties).filter(([, value]) => typeof value === "string")));
}

function nullableText(value: unknown): string | null {
  return isText(value) ? value : null;
}

function textOrEmpty(value: unknown): string {
  return isText(value) ? value : "";
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function providerStatus(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const response = (value as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return null;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

export function mapGoogleDriveFailure(value: unknown): Error {
  if (isDomainError(value)) return value;
  const status = providerStatus(value);
  const reason = safeProviderReason(value);
  const message = safeFailureMessage(status, reason);
  if (status === 401 || reason === "authError" || reason === "invalidCredentials") return new DriveReauthorizationRequiredError(message);
  if (reason === "dailyLimitExceeded") return new DriveProviderCapacityBlockedError("temporary", retryAfterMs(value));
  if (reason === "activeItemCreationLimitExceeded") return new DriveProviderCapacityBlockedError("user-action", retryAfterMs(value));
  if (status === 429 || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
    return new DriveRateLimitedError({ retryAfterMs: retryAfterMs(value), sessionUsable: true, operationPhase: "metadata" });
  }
  if (reason === "storageQuotaExceeded") return new DriveQuotaExceededError(message);
  if (reason === "domainPolicy" || reason === "accessNotConfigured" || reason === "insufficientFilePermissions" || status === 403) return new DrivePolicyBlockedError(message);
  if (status === 400 || reason === "invalidArgument" || reason === "badRequest") return new DriveConfigurationError(message);
  return new DriveTemporaryUnavailableError(message);
}

function isRejectedPageToken(value: unknown): boolean {
  if (providerStatus(value) !== 400) return false;
  const message = providerMessage(value);
  return typeof message === "string" && /page\s*token/iu.test(message);
}

function safeProviderReason(value: unknown): string | null {
  const error = providerError(value);
  const candidate = typeof error?.reason === "string"
    ? error.reason
    : Array.isArray(error?.errors) && typeof error.errors[0]?.reason === "string"
      ? error.errors[0].reason
      : null;
  return candidate !== null && SAFE_REASONS.has(candidate) ? candidate : null;
}

function providerMessage(value: unknown): unknown {
  return providerError(value)?.message;
}

function providerError(value: unknown): { reason?: unknown; errors?: { reason?: unknown }[]; message?: unknown } | null {
  if (typeof value !== "object" || value === null) return null;
  const response = (value as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return null;
  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const error = (data as { error?: unknown }).error;
  return typeof error === "object" && error !== null ? error : null;
}

function safeFailureMessage(status: number | null, reason: string | null): string {
  const detail = [status === null ? null : String(status), reason].filter((value): value is string => value !== null).join(": ");
  return detail ? `Google Drive request failed (${detail})` : "Google Drive request failed";
}

function isDomainError(value: unknown): value is Error {
  return value instanceof DriveFolderAmbiguousError
    || value instanceof DriveConfigurationError
    || value instanceof DrivePolicyBlockedError
    || value instanceof DriveQuotaExceededError
    || value instanceof DriveProviderCapacityBlockedError
    || value instanceof DriveRateLimitedError
    || value instanceof DriveReauthorizationRequiredError
    || value instanceof DriveTemporaryUnavailableError;
}

const SAFE_REASONS = new Set([
  "accessNotConfigured",
  "activeItemCreationLimitExceeded",
  "authError",
  "backendError",
  "badRequest",
  "dailyLimitExceeded",
  "domainPolicy",
  "insufficientFilePermissions",
  "invalidArgument",
  "invalidCredentials",
  "rateLimitExceeded",
  "storageQuotaExceeded",
  "userRateLimitExceeded",
]);

function retryAfterMs(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const response = (value as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return null;
  const headers = (response as { headers?: unknown }).headers;
  if (typeof headers !== "object" || headers === null) return null;
  const entries = Object.entries(headers as Record<string, unknown>);
  const candidate = entries.find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  if (typeof candidate !== "string") return null;
  if (/^\d+$/u.test(candidate)) {
    const seconds = Number(candidate);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
  }
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : null;
}
