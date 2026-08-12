import { DriveObjectConflictError } from "./errors/drive-object-conflict.error";

export interface CanonicalSharingState {
  ownerPermissionId: string;
  shared: boolean;
  permissionIds: readonly string[];
}

export interface VerifiedDriveObject {
  id: string;
  name: string;
  parentId: string;
  mimeType: string;
  size: number;
  sha256: string;
  md5: string | null;
  createdTimeMs: number;
  headRevisionId: string;
  version: string;
  ownedByMe: boolean;
  canDelete: boolean;
  trashed: boolean;
  appProperties: Readonly<Record<string, string>>;
  sharing: CanonicalSharingState;
  webViewLink: string | null;
}

export type VerifiedDriveObjectMetadata = Readonly<VerifiedDriveObject>;

export function createVerifiedDriveObjectMetadata(
  remote: VerifiedDriveObject,
): VerifiedDriveObjectMetadata {
  if (!isRecord(remote)) {
    throw new DriveObjectConflictError(
      "Drive verification metadata is malformed",
    );
  }
  requireText(remote.id, "Drive object ID");
  requireText(remote.name, "Drive object name");
  requireText(remote.parentId, "Drive parent ID");
  requireText(remote.mimeType, "Drive MIME type");
  requireNonNegativeInteger(remote.size, "Drive size");
  requireDigest(remote.sha256, 64, "Drive SHA-256");
  if (remote.md5 !== null) requireDigest(remote.md5, 32, "Drive MD5");
  requireNonNegativeInteger(remote.createdTimeMs, "Drive creation time");
  requireText(remote.headRevisionId, "Drive head revision ID");
  requireText(remote.version, "Drive version");
  if (
    typeof remote.ownedByMe !== "boolean" ||
    typeof remote.canDelete !== "boolean"
  ) {
    throw new DriveObjectConflictError("Drive ownership metadata is malformed");
  }
  if (typeof remote.trashed !== "boolean") {
    throw new DriveObjectConflictError("Drive trash metadata is malformed");
  }
  if (remote.webViewLink !== null && typeof remote.webViewLink !== "string") {
    throw new DriveObjectConflictError("Drive web view link is malformed");
  }
  const appProperties = canonicalAppProperties(remote.appProperties);
  const sharing = canonicalSharingState(remote.sharing);

  return Object.freeze({
    ...remote,
    appProperties,
    sharing,
  });
}

export function requirePrivateOwnedDriveObjectMetadata(
  remote: VerifiedDriveObject,
): VerifiedDriveObjectMetadata {
  const metadata = createVerifiedDriveObjectMetadata(remote);
  if (
    !metadata.ownedByMe ||
    !metadata.canDelete ||
    metadata.trashed ||
    metadata.sharing.shared ||
    metadata.sharing.permissionIds.length !== 1 ||
    metadata.sharing.permissionIds[0] !== metadata.sharing.ownerPermissionId
  ) {
    throw new DriveObjectConflictError(
      "Drive verification does not establish private ownership",
    );
  }
  return metadata;
}

export function canonicalSharingState(
  sharing: CanonicalSharingState,
): Readonly<CanonicalSharingState> {
  if (!isRecord(sharing)) {
    throw new DriveObjectConflictError("Drive sharing metadata is malformed");
  }
  requireText(sharing.ownerPermissionId, "Drive owner permission ID");
  if (
    typeof sharing.shared !== "boolean" ||
    !isStringArray(sharing.permissionIds)
  ) {
    throw new DriveObjectConflictError("Drive sharing metadata is malformed");
  }
  const permissionIds = [...sharing.permissionIds];
  if (
    permissionIds.some(
      (permissionId) => typeof permissionId !== "string" || !permissionId,
    ) ||
    new Set(permissionIds).size !== permissionIds.length ||
    permissionIds.some((permissionId, index) =>
      index > 0
        ? compareOpaqueIds(permissionIds[index - 1], permissionId) >= 0
        : false,
    ) ||
    !permissionIds.includes(sharing.ownerPermissionId) ||
    sharing.shared !== permissionIds.length > 1
  ) {
    throw new DriveObjectConflictError(
      "Drive permission IDs are not canonical",
    );
  }
  return Object.freeze({
    ownerPermissionId: sharing.ownerPermissionId,
    shared: sharing.shared,
    permissionIds: Object.freeze(permissionIds),
  });
}

function compareOpaqueIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalAppProperties(
  properties: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!isRecord(properties)) {
    throw new DriveObjectConflictError("Drive app properties are malformed");
  }
  for (const [key, value] of Object.entries(properties)) {
    if (!key || typeof value !== "string") {
      throw new DriveObjectConflictError("Drive app properties are malformed");
    }
  }
  return Object.freeze({ ...properties });
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value) {
    throw new DriveObjectConflictError(`${label} is missing`);
  }
}

function requireDigest(value: unknown, length: number, label: string): void {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[a-f0-9]{${length}}$`, "iu").test(value)
  ) {
    throw new DriveObjectConflictError(`${label} is malformed`);
  }
}

function requireNonNegativeInteger(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DriveObjectConflictError(`${label} is malformed`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
