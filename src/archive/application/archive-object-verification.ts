import { createHash } from 'node:crypto';
import { encodeArchiveAppProperties } from '../domain/app-properties';
import type { ArchiveArtifact } from '../domain/archive-artifact.entity';
import type { DriveConnection } from '../domain/drive-connection.entity';
import type { VerifiedDriveObject } from '../domain/drive-object-metadata.value-object';
import { MotionArchivePath } from '../domain/motion-archive-path.value-object';
import type {
  ArchiveObjectAttempt,
  VerifiedArchiveObject,
} from './ports/archive-artifact-repository.port';
import type { ArchiveUploadSourcePort } from './use-cases/upload-drive-object-attempt.use-case';

export type RemoteReconciliation = 'exact' | 'rename' | 'missing' | 'detached';

export function classifyRemoteObject(
  artifact: ArchiveArtifact,
  attempt: ArchiveObjectAttempt,
  connection: DriveConnection,
  remote: VerifiedDriveObject | null,
): RemoteReconciliation {
  if (remote === null || remote.trashed) return 'missing';
  const stored = attempt.verifiedObject;
  if (stored === null) return 'detached';
  if (!matchesRequiredIdentity(artifact, attempt, connection, remote)) return 'detached';
  if (!sameNonPresentationMetadata(stored, remote)) return 'detached';
  if (remote.name === stored.name && remote.version === stored.version) return 'exact';
  if (remote.name !== stored.name) return 'rename';
  return 'detached';
}

export function isAdoptableRemoteObject(
  artifact: ArchiveArtifact,
  connection: DriveConnection,
  remote: VerifiedDriveObject,
  expectedParent: string,
): boolean {
  return remote.parentId === expectedParent
    && remote.mimeType === mimeTypeFor(artifact)
    && remote.size === artifact.size
    && remote.sha256 === artifact.sha256
    && remote.headRevisionId.length > 0
    && remote.ownedByMe
    && remote.canDelete
    && !remote.trashed
    && remote.sharing.ownerPermissionId === connection.permissionId
    && !remote.sharing.shared
    && remote.sharing.permissionIds.length === 1
    && remote.sharing.permissionIds[0] === connection.permissionId
    && sameRecord(remote.appProperties, expectedProperties(artifact, connection.id));
}

export async function hasUnchangedTrustedSource(
  artifact: ArchiveArtifact,
  source: ArchiveUploadSourcePort,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    throwIfAborted(signal);
    const before = await source.stat(artifact.trustedPath, signal);
    if (before.size !== artifact.size || before.mtimeNs !== artifact.mtimeNs) return false;
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const part of source.open(artifact.trustedPath, 0, artifact.size, signal)) {
      throwIfAborted(signal);
      bytes += part.byteLength;
      if (bytes > artifact.size) return false;
      hash.update(part);
    }
    if (bytes !== artifact.size || hash.digest('hex') !== artifact.sha256) return false;
    const after = await source.stat(artifact.trustedPath, signal);
    return after.size === artifact.size && after.mtimeNs === artifact.mtimeNs;
  } catch (_error) {
    if (signal.aborted) throw abortReason(signal);
    return false;
  }
}

export function toArchiveObject(remote: VerifiedDriveObject): VerifiedArchiveObject {
  return {
    objectId: remote.id,
    name: remote.name,
    containerId: remote.parentId,
    contentType: remote.mimeType,
    size: remote.size,
    sha256: remote.sha256,
    md5: remote.md5,
    providerCreatedAtMs: remote.createdTimeMs,
    revisionId: remote.headRevisionId,
    version: remote.version,
    ownedByInstallation: remote.ownedByMe,
    canDelete: remote.canDelete,
    trashed: remote.trashed,
    attributes: remote.appProperties,
    sharing: remote.sharing,
    webViewLink: remote.webViewLink,
  };
}

export function parentFor(artifact: ArchiveArtifact, connection: DriveConnection): string {
  if (connection.folders === null) return '';
  return artifact.kind === 'database_backup'
    ? connection.folders.backupsId
    : connection.folders.motionId;
}

function matchesRequiredIdentity(
  artifact: ArchiveArtifact,
  attempt: ArchiveObjectAttempt,
  connection: DriveConnection,
  remote: VerifiedDriveObject,
): boolean {
  return remote.id === attempt.remoteObjectId
    && attempt.generationId === connection.id
    && artifact.installationId === connection.installationId
    && remote.parentId === attempt.containerId
    && remote.mimeType === mimeTypeFor(artifact)
    && remote.size === artifact.size
    && remote.sha256 === artifact.sha256
    && remote.ownedByMe
    && remote.canDelete
    && remote.sharing.ownerPermissionId === connection.permissionId
    && !remote.sharing.shared
    && remote.sharing.permissionIds.length === 1
    && remote.sharing.permissionIds[0] === connection.permissionId
    && sameRecord(remote.appProperties, expectedProperties(artifact, attempt.generationId));
}

function sameNonPresentationMetadata(
  stored: VerifiedArchiveObject,
  remote: VerifiedDriveObject,
): boolean {
  return remote.id === stored.objectId
    && remote.parentId === stored.containerId
    && remote.mimeType === stored.contentType
    && remote.size === stored.size
    && remote.sha256 === stored.sha256
    && remote.md5 === stored.md5
    && remote.createdTimeMs === stored.providerCreatedAtMs
    && remote.headRevisionId === stored.revisionId
    && remote.ownedByMe === stored.ownedByInstallation
    && remote.canDelete === stored.canDelete
    && remote.trashed === stored.trashed
    && sameRecord(remote.appProperties, stored.attributes)
    && remote.sharing.ownerPermissionId === stored.sharing.ownerPermissionId
    && remote.sharing.shared === stored.sharing.shared
    && sameStrings(remote.sharing.permissionIds, stored.sharing.permissionIds)
    && remote.webViewLink === stored.webViewLink;
}

function expectedProperties(artifact: ArchiveArtifact, generationId: string) {
  return encodeArchiveAppProperties({
    installationId: artifact.installationId,
    generationId,
    kind: artifact.kind,
    sourceFingerprint: artifact.sourceFingerprint,
    sha256: artifact.sha256,
    sourceTimeMs: artifact.sourceTimeMs,
    schemaVersion: 1,
  });
}

function mimeTypeFor(artifact: ArchiveArtifact): string {
  return artifact.kind === 'motion_video'
    ? MotionArchivePath.parse(artifact.relativePath).contentType
    : 'application/vnd.sqlite3';
}

function sameRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return sameStrings(leftKeys, rightKeys)
    && leftKeys.every((key) => left[key] === right[key]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}
