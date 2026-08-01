import { createHash, randomUUID, type Hash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
  type ArchiveObjectAttempt,
  type AttemptLease,
  type ClaimedAttempt,
  type VerifiedArchiveObject,
} from '../ports/archive-artifact-repository.port';
import {
  ARCHIVE_SECRET_CIPHER,
  type ArchiveSecretCipherPort,
} from '../ports/archive-secret-cipher.port';
import {
  DRIVE_ARCHIVE,
  type DriveArchivePort,
  type UploadSession,
} from '../ports/drive-archive.port';
import {
  DRIVE_CREDENTIAL_REPOSITORY,
  type DriveCredentialRepositoryPort,
} from '../ports/drive-credential-repository.port';
import { encodeArchiveAppProperties, matchesArchiveAppProperties } from '../../domain/app-properties';
import type { ArchiveArtifact } from '../../domain/archive-artifact.entity';
import type { DriveConnection } from '../../domain/drive-connection.entity';
import type { VerifiedDriveObject } from '../../domain/drive-object-metadata.value-object';
import { DriveAttemptLeaseLostError } from '../../domain/errors/drive-attempt-lease-lost.error';
import { DriveConfigurationError } from '../../domain/errors/drive-configuration.error';
import { DriveLocalSourceChangedError } from '../../domain/errors/drive-local-source-changed.error';
import { DriveObjectConflictError } from '../../domain/errors/drive-object-conflict.error';
import { ArchiveTransferSemaphoreService } from '../archive-transfer-semaphore.service';

const CHUNK_SIZE = 256 * 1024;
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const DEFAULT_RETRY_DELAY_MS = 30_000;

export interface ArchiveUploadSourceStat {
  size: number;
  mtimeNs: string;
}

export const ARCHIVE_UPLOAD_SOURCE = Symbol('ARCHIVE_UPLOAD_SOURCE');

/** Provider-neutral bounded local-byte reader. Node streams stay in infrastructure. */
export interface ArchiveUploadSourcePort {
  stat(path: string, signal: AbortSignal): Promise<ArchiveUploadSourceStat>;
  open(path: string, start: number, endExclusive: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export type UploadDriveObjectAttemptResult =
  | { kind: 'verified'; attemptId: string; fileId: string }
  | { kind: 'replaced'; attemptId: string; replacementAttemptId: string; replacementFileId: string };

export interface UploadDriveObjectAttemptOptions {
  now?: () => number;
  owner?: () => string;
  leaseMs?: number;
  retryDelayMs?: number;
}

/** Streams or resumes one immutable exact-ID Drive object attempt. */
@Injectable()
export class UploadDriveObjectAttemptUseCase {
  private readonly now: () => number;
  private readonly owner: () => string;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;

  constructor(
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY)
    private readonly repository: ArchiveArtifactRepositoryPort,
    @Inject(DRIVE_CREDENTIAL_REPOSITORY)
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'loadActive'>,
    @Inject(DRIVE_ARCHIVE)
    private readonly drive: DriveArchivePort,
    @Inject(ARCHIVE_SECRET_CIPHER)
    private readonly cipher: ArchiveSecretCipherPort,
    @Inject(ARCHIVE_UPLOAD_SOURCE)
    private readonly source: ArchiveUploadSourcePort,
    private readonly semaphore: ArchiveTransferSemaphoreService,
    options: UploadDriveObjectAttemptOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.owner = options.owner ?? randomUUID;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async execute(id: string, signal: AbortSignal): Promise<UploadDriveObjectAttemptResult> {
    throwIfAborted(signal);
    const connection = await this.requireActiveConnection();
    let attempt = await this.repository.loadAttempt(id);
    let artifact: ArchiveArtifact | null;
    if (attempt === null) {
      artifact = await this.repository.loadArtifact(id);
      if (artifact === null) throw new DriveObjectConflictError('Archive upload target does not exist');
      this.requireConnection(artifact, connection);
      const fileId = await this.drive.generateFileId(connection, signal);
      const parentId = parentFor(artifact, connection);
      attempt = await this.repository.createAttempt(artifact.id, connection.id, fileId, parentId, this.now());
    } else {
      artifact = await this.repository.loadArtifact(attempt.artifactId);
      if (artifact === null) throw new DriveObjectConflictError('Archive artifact does not exist');
      this.requireConnection(artifact, connection, attempt);
    }

    const claimed = await this.repository.claimAttempt(attempt.id, {
      owner: this.owner(), nowMs: this.now(), leaseMs: this.leaseMs,
    });
    let lease = claimed.lease;
    let terminalized = false;
    let release: (() => void) | null = null;
    try {
      await this.requireUnchangedSource(claimed.artifact, signal);
      release = await this.semaphore.acquire(claimed.artifact.kind, signal);
      lease = await this.renew(claimed.attempt.id, lease);
      const result = await this.transfer(claimed, connection, lease, signal, (next) => { lease = next; });
      terminalized = true;
      return result;
    } catch (error) {
      if (!terminalized) await this.releaseAsRetryable(claimed.attempt.id, lease, error);
      throw error;
    } finally {
      release?.();
    }
  }

  private async transfer(
    claimed: ClaimedAttempt,
    connection: DriveConnection,
    initialLease: AttemptLease,
    signal: AbortSignal,
    updateLease: (lease: AttemptLease) => void,
  ): Promise<UploadDriveObjectAttemptResult> {
    const { artifact, attempt } = claimed;
    const expectedProperties = encodeArchiveAppProperties({
      installationId: artifact.installationId,
      generationId: attempt.generationId,
      kind: artifact.kind,
      sourceFingerprint: artifact.sourceFingerprint,
      sha256: artifact.sha256,
      sourceTimeMs: artifact.sourceTimeMs,
      schemaVersion: 1,
    });
    let lease = initialLease;
    let session: UploadSession | null = null;
    let offset = 0;

    if (attempt.session !== null) {
      session = await this.decryptSession(artifact, attempt);
      if (attempt.session.expiresAtMs > this.now()) {
        const status = await this.drive.querySession({ connection, uri: session.uri, totalSize: artifact.size }, signal);
        if (status.kind === 'complete') {
          return this.verify(attempt, artifact, connection, expectedProperties, lease, signal);
        }
        if (status.kind === 'resume') offset = status.confirmedOffset;
        if (status.kind === 'expired') {
          const recovered = await this.drive.loadObject(connection, attempt.remoteObjectId, signal);
          if (recovered !== null) return this.verifyLoaded(attempt, artifact, expectedProperties, recovered, lease, signal);
          session = null;
        }
      } else {
        session = null;
      }
    } else {
      const recovered = await this.drive.loadObject(connection, attempt.remoteObjectId, signal);
      if (recovered !== null) return this.verifyLoaded(attempt, artifact, expectedProperties, recovered, lease, signal);
    }

    if (session === null) {
      try {
        session = await this.drive.beginResumableUpload({
          connection,
          fileId: attempt.remoteObjectId,
          parentId: attempt.containerId,
          name: fileName(artifact.relativePath),
          mimeType: mimeTypeFor(artifact),
          size: artifact.size,
          appProperties: expectedProperties,
        }, signal);
      } catch (error) {
        const recovered = await this.drive.loadObject(connection, attempt.remoteObjectId, signal);
        if (recovered !== null) return this.verifyLoaded(attempt, artifact, expectedProperties, recovered, lease, signal);
        if (isConflict(error)) {
          await this.repository.markConflict(attempt.id, lease, 'reserved_id_conflict', this.now());
          const replacementFileId = await this.drive.generateFileId(connection, signal);
          const replacement = await this.repository.createAttempt(
            artifact.id, connection.id, replacementFileId, attempt.containerId, this.now(),
          );
          return { kind: 'replaced', attemptId: attempt.id, replacementAttemptId: replacement.id, replacementFileId };
        }
        throw error;
      }
      const encrypted = await this.cipher.encrypt(Buffer.from(session.uri, 'utf8'), sessionContext(artifact, attempt));
      lease = await this.repository.saveSession(attempt.id, lease, {
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.version,
        formatVersion: 1,
        createdAtMs: session.createdAtMs,
        expiresAtMs: session.expiresAtMs,
        confirmedOffset: 0,
      }, this.now());
      updateLease(lease);
      offset = 0;
    }

    let hasher = createHash('sha256');
    if (offset > 0) await this.hashRange(artifact, 0, offset, hasher, signal);
    while (offset < artifact.size) {
      throwIfAborted(signal);
      lease = await this.renew(attempt.id, lease);
      updateLease(lease);
      const endExclusive = Math.min(offset + CHUNK_SIZE, artifact.size);
      const counted = { bytes: 0 };
      const result = await this.drive.uploadChunk({
        connection,
        fileId: attempt.remoteObjectId,
        uri: session.uri,
        start: offset,
        endInclusive: endExclusive - 1,
        totalSize: artifact.size,
        body: hashBody(this.source.open(artifact.trustedPath, offset, endExclusive, signal), hasher, counted, signal),
      }, signal);
      if (counted.bytes !== endExclusive - offset) throw new DriveLocalSourceChangedError('Local archive source ended during upload');
      if (result.kind === 'complete') {
        offset = artifact.size;
        break;
      }
      const confirmed = result.confirmedOffset;
      if (!Number.isSafeInteger(confirmed) || confirmed < 0 || confirmed > artifact.size) {
        throw new DriveObjectConflictError('Google confirmed an invalid upload offset');
      }
      if (confirmed !== endExclusive) {
        hasher = createHash('sha256');
        if (confirmed > 0) await this.hashRange(artifact, 0, confirmed, hasher, signal);
      }
      offset = confirmed;
      lease = await this.repository.confirmOffset(attempt.id, lease, offset, this.now());
      updateLease(lease);
    }

    const transferredDigest = hasher.digest('hex');
    if (transferredDigest !== artifact.sha256) throw new DriveLocalSourceChangedError('Transferred archive digest changed');
    return this.verify(attempt, artifact, connection, expectedProperties, lease, signal, transferredDigest);
  }

  private async verify(
    attempt: ArchiveObjectAttempt,
    artifact: ArchiveArtifact,
    connection: DriveConnection,
    expectedProperties: Readonly<Record<string, string>>,
    lease: AttemptLease,
    signal: AbortSignal,
    transferredDigest?: string,
  ): Promise<UploadDriveObjectAttemptResult> {
    const remote = await this.drive.loadObject(connection, attempt.remoteObjectId, signal);
    if (remote === null) throw new DriveObjectConflictError('Reserved Drive object is missing after upload');
    return this.verifyLoaded(attempt, artifact, expectedProperties, remote, lease, signal, transferredDigest);
  }

  private async verifyLoaded(
    attempt: ArchiveObjectAttempt,
    artifact: ArchiveArtifact,
    expectedProperties: Readonly<Record<string, string>>,
    remote: VerifiedDriveObject,
    lease: AttemptLease,
    signal: AbortSignal,
    transferredDigest?: string,
  ): Promise<UploadDriveObjectAttemptResult> {
    const digest = transferredDigest ?? await this.digestWholeSource(artifact, signal);
    await this.requireUnchangedSource(artifact, signal);
    if (digest !== artifact.sha256
      || remote.id !== attempt.remoteObjectId
      || remote.name !== fileName(artifact.relativePath)
      || remote.parentId !== attempt.containerId
      || remote.mimeType !== mimeTypeFor(artifact)
      || remote.size !== artifact.size
      || remote.sha256 !== artifact.sha256
      || !remote.headRevisionId
      || !matchesArchiveAppProperties(expectedProperties, remote.appProperties)
      || !remote.ownedByMe || !remote.canDelete || remote.trashed
      || remote.sharing.shared || remote.sharing.permissionIds.length !== 1
      || remote.sharing.permissionIds[0] !== remote.sharing.ownerPermissionId) {
      throw new DriveObjectConflictError('Drive object verification is not exact and private');
    }
    await this.repository.markVerified(attempt.id, lease, toArchiveObject(remote), this.now());
    return { kind: 'verified', attemptId: attempt.id, fileId: attempt.remoteObjectId };
  }

  private async digestWholeSource(artifact: ArchiveArtifact, signal: AbortSignal): Promise<string> {
    const hash = createHash('sha256');
    await this.hashRange(artifact, 0, artifact.size, hash, signal);
    return hash.digest('hex');
  }

  private async hashRange(artifact: ArchiveArtifact, start: number, endExclusive: number, hash: Hash, signal: AbortSignal): Promise<void> {
    let bytes = 0;
    for await (const part of this.source.open(artifact.trustedPath, start, endExclusive, signal)) {
      throwIfAborted(signal);
      bytes += part.byteLength;
      if (bytes > endExclusive - start) throw new DriveLocalSourceChangedError('Local archive source exceeded its immutable range');
      hash.update(part);
    }
    if (bytes !== endExclusive - start) throw new DriveLocalSourceChangedError('Local archive source ended during hashing');
  }

  private async requireUnchangedSource(artifact: ArchiveArtifact, signal: AbortSignal): Promise<void> {
    const source = await this.source.stat(artifact.trustedPath, signal);
    if (source.size !== artifact.size || source.mtimeNs !== artifact.mtimeNs) throw new DriveLocalSourceChangedError();
  }

  private async decryptSession(artifact: ArchiveArtifact, attempt: ArchiveObjectAttempt): Promise<UploadSession> {
    const session = attempt.session;
    if (session === null) throw new DriveConfigurationError('Upload session is missing');
    if (session.keyVersion !== 1) throw new DriveConfigurationError('Upload session key version is unsupported');
    const plaintext = await this.cipher.decrypt({
      version: 1,
      iv: session.nonce,
      ciphertext: session.ciphertext,
      authTag: session.authTag,
    }, sessionContext(artifact, attempt));
    const uri = plaintext.toString('utf8');
    plaintext.fill(0);
    if (!uri) throw new DriveConfigurationError('Upload session is invalid');
    return { uri, createdAtMs: session.createdAtMs, expiresAtMs: session.expiresAtMs };
  }

  private async renew(attemptId: string, lease: AttemptLease): Promise<AttemptLease> {
    return this.repository.renewLease(attemptId, lease, this.now(), this.leaseMs);
  }

  private async releaseAsRetryable(attemptId: string, lease: AttemptLease, error: unknown): Promise<void> {
    if (error instanceof DriveAttemptLeaseLostError) return;
    try {
      await this.repository.markRetryable(
        attemptId,
        lease,
        errorCode(error),
        this.now() + this.retryDelayMs,
        this.now(),
      );
    } catch (markError) {
      if (!(markError instanceof DriveAttemptLeaseLostError)) throw markError;
    }
  }

  private async requireActiveConnection(): Promise<DriveConnection> {
    const connection = await this.credentials.loadActive();
    if (connection?.status !== 'active' || connection.folders === null) {
      throw new DriveConfigurationError('Active Drive connection is unavailable');
    }
    return connection;
  }

  private requireConnection(artifact: ArchiveArtifact, connection: DriveConnection, attempt?: ArchiveObjectAttempt): void {
    if (artifact.installationId !== connection.installationId
      || (attempt !== undefined && (attempt.generationId !== connection.id || attempt.containerId !== parentFor(artifact, connection)))) {
      throw new DriveObjectConflictError('Archive attempt does not belong to the active Drive generation');
    }
  }
}

async function* hashBody(
  body: AsyncIterable<Uint8Array>, hash: Hash, counted: { bytes: number }, signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  for await (const part of body) {
    throwIfAborted(signal);
    counted.bytes += part.byteLength;
    hash.update(part);
    yield part;
  }
}

function sessionContext(artifact: ArchiveArtifact, attempt: ArchiveObjectAttempt) {
  return { installationId: artifact.installationId, rowId: attempt.id, kind: 'upload-session' as const, schemaVersion: 1 };
}

function parentFor(artifact: ArchiveArtifact, connection: DriveConnection): string {
  const folders = connection.folders;
  if (folders === null) throw new DriveConfigurationError('Managed Drive folders are unavailable');
  return artifact.kind === 'database_backup' ? folders.backupsId : folders.motionId;
}

function fileName(relativePath: string): string {
  const name = relativePath.split('/').filter(Boolean).at(-1);
  if (!name) throw new DriveConfigurationError('Archive object name is invalid');
  return name;
}

function mimeTypeFor(artifact: ArchiveArtifact): string {
  return artifact.kind === 'motion_video' ? 'video/mp4' : 'application/vnd.sqlite3';
}

function toArchiveObject(remote: VerifiedDriveObject): VerifiedArchiveObject {
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

function isConflict(error: unknown): boolean {
  return error instanceof DriveObjectConflictError || (error instanceof Error && error.name === 'DriveObjectConflictError');
}

function errorCode(error: unknown): string {
  if (error instanceof DriveLocalSourceChangedError) return 'local_source_changed';
  if (error instanceof DriveObjectConflictError) return 'remote_conflict';
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return 'temporary_failure';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}
