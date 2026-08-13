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
import { DriveFolderBranchBlockedError } from '../../domain/errors/drive-folder-branch-blocked.error';
import { DriveLocalSourceChangedError } from '../../domain/errors/drive-local-source-changed.error';
import { DriveObjectConflictError } from '../../domain/errors/drive-object-conflict.error';
import { MotionArchivePath } from '../../domain/motion-archive-path.value-object';
import { ArchiveTransferSemaphoreService } from '../archive-transfer-semaphore.service';
import type { ArchiveRemoteMutationLockService } from '../archive-remote-mutation-lock.service';
import type { ResolveMotionArchiveContainerUseCase } from './resolve-motion-archive-container.use-case';

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
  activityGate?: Pick<ArchiveRemoteMutationLockService, 'runActivity'>;
}

/** Streams or resumes one immutable exact-ID Drive object attempt. */
@Injectable()
export class UploadDriveObjectAttemptUseCase {
  private readonly now: () => number;
  private readonly owner: () => string;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly activityGate?: Pick<ArchiveRemoteMutationLockService, 'runActivity'>;
  private readonly containerResolver?: Pick<ResolveMotionArchiveContainerUseCase, 'execute'>;

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
    resolverOrOptions: Pick<ResolveMotionArchiveContainerUseCase, 'execute'> | UploadDriveObjectAttemptOptions = {},
    options: UploadDriveObjectAttemptOptions = {},
  ) {
    const hasResolver = isContainerResolver(resolverOrOptions);
    const resolver = hasResolver ? resolverOrOptions : undefined;
    const configured: UploadDriveObjectAttemptOptions = hasResolver ? options : resolverOrOptions;
    this.containerResolver = resolver;
    this.now = configured.now ?? Date.now;
    this.owner = configured.owner ?? randomUUID;
    this.leaseMs = configured.leaseMs ?? DEFAULT_LEASE_MS;
    this.retryDelayMs = configured.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.activityGate = configured.activityGate;
  }

  async execute(id: string, signal: AbortSignal): Promise<UploadDriveObjectAttemptResult> {
    if (this.activityGate !== undefined) {
      return this.activityGate.runActivity(() => this.executeActive(id, signal));
    }
    return this.executeActive(id, signal);
  }

  private async executeActive(id: string, signal: AbortSignal): Promise<UploadDriveObjectAttemptResult> {
    throwIfAborted(signal);
    const connection = await this.requireActiveConnection();
    let attempt = await this.repository.loadAttempt(id);
    let artifact: ArchiveArtifact | null;
    if (attempt === null) {
      artifact = await this.repository.loadArtifact(id);
      if (artifact === null) throw new DriveObjectConflictError('Archive upload target does not exist');
      this.requireConnection(artifact, connection);
      const prepared = await this.prepareUnattemptedArtifact(artifact, connection, signal);
      artifact = prepared.artifact;
      try {
        const fileId = await this.drive.generateFileId(connection, signal);
        attempt = await this.repository.createAttempt(
          artifact.id, connection.id, fileId, prepared.containerId, this.now(),
        );
      } catch (error) {
        if (artifact.kind === 'motion_video') {
          await this.repository.markAdmissionRetryable(
            artifact.id,
            artifact.admission.revision,
            errorCode(error),
            this.now() + this.retryDelayMs,
            this.now(),
          );
        }
        throw error;
      }
      const claimed = await this.repository.claimAttempt(attempt.id, {
        owner: this.owner(), nowMs: this.now(), leaseMs: this.leaseMs,
      });
      return this.runClaimed(claimed, connection, signal, prepared.containerId);
    } else {
      artifact = await this.repository.loadArtifact(attempt.artifactId);
      if (artifact === null) throw new DriveObjectConflictError('Archive artifact does not exist');
      this.requireConnection(artifact, connection, attempt);
      artifact = await this.prepareExistingAdmission(artifact, attempt, signal);
    }

    const claimed = await this.repository.claimAttempt(attempt.id, {
      owner: this.owner(), nowMs: this.now(), leaseMs: this.leaseMs,
    });
    return this.runClaimed(claimed, connection, signal);
  }

  /** Runs a scheduler-owned short-CAS claim without attempting to claim it twice. */
  async executeClaimed(
    claimed: ClaimedAttempt,
    signal: AbortSignal,
  ): Promise<UploadDriveObjectAttemptResult> {
    if (this.activityGate !== undefined) {
      return this.activityGate.runActivity(() => this.executeClaimedActive(claimed, signal));
    }
    return this.executeClaimedActive(claimed, signal);
  }

  private async executeClaimedActive(
    claimed: ClaimedAttempt,
    signal: AbortSignal,
  ): Promise<UploadDriveObjectAttemptResult> {
    throwIfAborted(signal);
    const connection = await this.requireActiveConnection();
    this.requireConnection(claimed.artifact, connection, claimed.attempt);
    const artifact = await this.prepareExistingAdmission(
      claimed.artifact, claimed.attempt, signal, claimed.lease,
    );
    return this.runClaimed({ ...claimed, artifact }, connection, signal);
  }

  private async runClaimed(
    claimed: ClaimedAttempt,
    connection: DriveConnection,
    signal: AbortSignal,
    knownContainerId?: string,
  ): Promise<UploadDriveObjectAttemptResult> {
    let lease = claimed.lease;
    let terminalized = false;
    let release: (() => void) | null = null;
    try {
      try {
        await this.requireUnchangedSource(claimed.artifact, signal);
      } catch (error) {
        const localCode = localIdentityErrorCode(error);
        if (claimed.artifact.kind === 'motion_video' && localCode !== null) {
          await this.repository.terminalizeArtifactAttempt({
            artifactId: claimed.artifact.id,
            expectedAdmissionRevision: claimed.artifact.admission.revision,
            attemptId: claimed.attempt.id,
            lease,
            errorCode: localCode,
            nowMs: this.now(),
          });
          terminalized = true;
        }
        throw error;
      }
      const resolvedContainerId = knownContainerId
        ?? await this.resolveContainer(claimed.artifact, connection, signal);
      release = await this.semaphore.acquire(claimed.artifact.kind, signal);
      lease = await this.renew(claimed.attempt.id, lease);
      if (resolvedContainerId !== claimed.attempt.containerId) {
        const result = await this.replaceChangedContainer(
          claimed, connection, resolvedContainerId, lease, signal, (next) => { lease = next; },
        );
        terminalized = true;
        return result;
      }
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
    const target = uploadTarget(artifact, connection);
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
          return this.verify(attempt, artifact, connection, expectedProperties, lease, signal, updateLease);
        }
        if (status.kind === 'resume') offset = status.confirmedOffset;
        if (status.kind === 'expired') {
          const recovered = await this.drive.loadObject(connection, attempt.remoteObjectId, signal);
          if (recovered !== null) {
            return this.verifyLoaded(attempt, artifact, connection, expectedProperties, recovered, lease, signal, updateLease, undefined, true);
          }
          session = null;
        }
      } else {
        session = null;
      }
    } else {
      const recovered = await this.drive.loadObject(connection, attempt.remoteObjectId, signal);
      if (recovered !== null) {
        return this.verifyLoaded(attempt, artifact, connection, expectedProperties, recovered, lease, signal, updateLease, undefined, true);
      }
    }

    if (session === null) {
      try {
        session = await this.drive.beginResumableUpload({
          connection,
          fileId: attempt.remoteObjectId,
          parentId: attempt.containerId,
          name: target.fileName,
          mimeType: target.contentType,
          size: artifact.size,
          appProperties: expectedProperties,
        }, signal);
      } catch (error) {
        const recovered = await this.drive.loadObject(connection, attempt.remoteObjectId, signal);
        if (recovered !== null) {
          return this.verifyLoaded(attempt, artifact, connection, expectedProperties, recovered, lease, signal, updateLease, undefined, true);
        }
        if (isConflict(error)) {
          return this.replaceConflict(attempt, connection, lease, signal);
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
    if (offset > 0) {
      lease = await this.hashRange(attempt.id, artifact, 0, offset, hasher, lease, signal, updateLease);
    }
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
        if (confirmed > 0) {
          lease = await this.hashRange(attempt.id, artifact, 0, confirmed, hasher, lease, signal, updateLease);
        }
      }
      offset = confirmed;
      lease = await this.repository.confirmOffset(attempt.id, lease, offset, this.now());
      updateLease(lease);
    }

    const transferredDigest = hasher.digest('hex');
    if (transferredDigest !== artifact.sha256) throw new DriveLocalSourceChangedError('Transferred archive digest changed');
    return this.verify(attempt, artifact, connection, expectedProperties, lease, signal, updateLease, transferredDigest);
  }

  private async verify(
    attempt: ArchiveObjectAttempt,
    artifact: ArchiveArtifact,
    connection: DriveConnection,
    expectedProperties: Readonly<Record<string, string>>,
    lease: AttemptLease,
    signal: AbortSignal,
    updateLease: (lease: AttemptLease) => void,
    transferredDigest?: string,
  ): Promise<UploadDriveObjectAttemptResult> {
    const remote = await this.drive.loadObject(connection, attempt.remoteObjectId, signal);
    if (remote === null) throw new DriveObjectConflictError('Reserved Drive object is missing after upload');
    return this.verifyLoaded(attempt, artifact, connection, expectedProperties, remote, lease, signal, updateLease, transferredDigest);
  }

  private async verifyLoaded(
    attempt: ArchiveObjectAttempt,
    artifact: ArchiveArtifact,
    connection: DriveConnection,
    expectedProperties: Readonly<Record<string, string>>,
    remote: VerifiedDriveObject,
    lease: AttemptLease,
    signal: AbortSignal,
    updateLease: (lease: AttemptLease) => void,
    transferredDigest?: string,
    replaceMismatch = false,
  ): Promise<UploadDriveObjectAttemptResult> {
    const target = uploadTarget(artifact, connection);
    let digest = transferredDigest;
    if (digest === undefined) {
      const hashed = await this.digestWholeSource(attempt.id, artifact, lease, signal, updateLease);
      digest = hashed.digest;
      lease = hashed.lease;
    }
    await this.requireUnchangedSource(artifact, signal);
    if (digest !== artifact.sha256
      || remote.id !== attempt.remoteObjectId
      || remote.name !== target.fileName
      || remote.parentId !== attempt.containerId
      || remote.mimeType !== target.contentType
      || remote.size !== artifact.size
      || remote.sha256 !== artifact.sha256
      || !remote.headRevisionId
      || !matchesArchiveAppProperties(expectedProperties, remote.appProperties)
      || !remote.ownedByMe || !remote.canDelete || remote.trashed
      || remote.sharing.shared || remote.sharing.permissionIds.length !== 1
      || remote.sharing.permissionIds[0] !== remote.sharing.ownerPermissionId) {
      if (replaceMismatch) return this.replaceConflict(attempt, connection, lease, signal);
      throw new DriveObjectConflictError('Drive object verification is not exact and private');
    }
    await this.repository.markVerified(attempt.id, lease, toArchiveObject(remote), this.now());
    return { kind: 'verified', attemptId: attempt.id, fileId: attempt.remoteObjectId };
  }

  private async digestWholeSource(
    attemptId: string,
    artifact: ArchiveArtifact,
    lease: AttemptLease,
    signal: AbortSignal,
    updateLease: (lease: AttemptLease) => void,
  ): Promise<{ digest: string; lease: AttemptLease }> {
    const hash = createHash('sha256');
    const renewed = await this.hashRange(attemptId, artifact, 0, artifact.size, hash, lease, signal, updateLease);
    return { digest: hash.digest('hex'), lease: renewed };
  }

  private async hashRange(
    attemptId: string,
    artifact: ArchiveArtifact,
    start: number,
    endExclusive: number,
    hash: Hash,
    lease: AttemptLease,
    signal: AbortSignal,
    updateLease: (lease: AttemptLease) => void,
  ): Promise<AttemptLease> {
    let bytes = 0;
    let renewAtMs = this.nextHashRenewalMs(lease);
    for await (const part of this.source.open(artifact.trustedPath, start, endExclusive, signal)) {
      throwIfAborted(signal);
      if (this.now() >= renewAtMs) {
        lease = await this.renew(attemptId, lease);
        updateLease(lease);
        renewAtMs = this.nextHashRenewalMs(lease);
      }
      bytes += part.byteLength;
      if (bytes > endExclusive - start) throw new DriveLocalSourceChangedError('Local archive source exceeded its immutable range');
      hash.update(part);
    }
    if (bytes !== endExclusive - start) throw new DriveLocalSourceChangedError('Local archive source ended during hashing');
    return lease;
  }

  private nextHashRenewalMs(lease: AttemptLease): number {
    return Math.min(lease.expiresAtMs - 1, this.now() + Math.max(1, Math.floor(this.leaseMs / 3)));
  }

  private async replaceConflict(
    attempt: ArchiveObjectAttempt,
    connection: DriveConnection,
    lease: AttemptLease,
    signal: AbortSignal,
  ): Promise<UploadDriveObjectAttemptResult> {
    const replacementFileId = await this.drive.generateFileId(connection, signal);
    const replacement = await this.repository.replaceConflictingAttempt(
      attempt.id, lease, replacementFileId, 'reserved_id_conflict', this.now(),
    );
    return { kind: 'replaced', attemptId: attempt.id, replacementAttemptId: replacement.id, replacementFileId };
  }

  private async replaceChangedContainer(
    claimed: ClaimedAttempt,
    connection: DriveConnection,
    replacementContainerId: string,
    lease: AttemptLease,
    signal: AbortSignal,
    updateLease: (lease: AttemptLease) => void,
  ): Promise<UploadDriveObjectAttemptResult> {
    const { artifact, attempt } = claimed;
    let activeLease = lease;
    const trackLease = (next: AttemptLease) => {
      activeLease = next;
      updateLease(next);
    };
    if (attempt.session !== null) {
      const session = await this.decryptSession(artifact, attempt);
      await this.drive.querySession({ connection, uri: session.uri, totalSize: artifact.size }, signal);
    }
    const remote = await this.drive.loadObject(connection, attempt.remoteObjectId, signal);
    if (remote !== null && !remote.trashed) {
      try {
        return await this.verifyLoaded(
          attempt,
          artifact,
          connection,
          encodeArchiveAppProperties({
            installationId: artifact.installationId,
            generationId: attempt.generationId,
            kind: artifact.kind,
            sourceFingerprint: artifact.sourceFingerprint,
            sha256: artifact.sha256,
            sourceTimeMs: artifact.sourceTimeMs,
            schemaVersion: 1,
          }),
          remote,
          activeLease,
          signal,
          trackLease,
        );
      } catch (error) {
        if (!(error instanceof DriveObjectConflictError)) throw error;
      }
    }
    const replacementFileId = await this.drive.generateFileId(connection, signal);
    const replacement = await this.repository.replaceAttemptForContainer({
      attemptId: attempt.id,
      fence: { kind: 'lease', lease: activeLease },
      expectedContainerId: attempt.containerId,
      terminalState: remote === null || remote.trashed ? 'missing' : 'detached',
      errorCode: remote === null || remote.trashed ? 'container_missing' : 'container_detached',
      replacementRemoteObjectId: replacementFileId,
      replacementContainerId,
      nowMs: this.now(),
    });
    return {
      kind: 'replaced',
      attemptId: attempt.id,
      replacementAttemptId: replacement.id,
      replacementFileId,
    };
  }

  private async prepareUnattemptedArtifact(
    artifact: ArchiveArtifact,
    connection: DriveConnection,
    signal: AbortSignal,
  ): Promise<{ artifact: ArchiveArtifact; containerId: string }> {
    let target: ReturnType<typeof uploadTarget>;
    try {
      target = uploadTarget(artifact, connection);
    } catch (error) {
      if (artifact.kind === 'motion_video') {
        await this.repository.markAdmissionTerminal(
          artifact.id, artifact.admission.revision, 'invalid_motion_path', this.now(),
        );
      }
      throw error;
    }
    if (target.directContainerId !== null) {
      return { artifact, containerId: target.directContainerId };
    }
    artifact = await this.recordAdmissionPath(artifact, target.dayPath!);
    try {
      await this.requireUnchangedSource(artifact, signal);
    } catch (error) {
      const localCode = localIdentityErrorCode(error);
      if (localCode !== null) {
        await this.repository.markAdmissionTerminal(
          artifact.id, artifact.admission.revision, localCode, this.now(),
        );
      }
      throw error;
    }
    try {
      return { artifact, containerId: await this.resolveContainer(artifact, connection, signal) };
    } catch (error) {
      if (!(error instanceof DriveFolderBranchBlockedError)) {
        await this.repository.markAdmissionRetryable(
          artifact.id,
          artifact.admission.revision,
          errorCode(error),
          this.now() + this.retryDelayMs,
          this.now(),
        );
      }
      throw error;
    }
  }

  private async prepareExistingAdmission(
    artifact: ArchiveArtifact,
    attempt: ArchiveObjectAttempt,
    signal: AbortSignal,
    claimedLease?: AttemptLease,
  ): Promise<ArchiveArtifact> {
    if (artifact.kind !== 'motion_video') return artifact;
    let path: MotionArchivePath;
    try {
      path = MotionArchivePath.parse(artifact.relativePath);
    } catch (error) {
      const lease = claimedLease ?? (await this.repository.claimAttempt(attempt.id, {
        owner: this.owner(), nowMs: this.now(), leaseMs: this.leaseMs,
      })).lease;
      await this.repository.terminalizeArtifactAttempt({
        artifactId: artifact.id,
        expectedAdmissionRevision: artifact.admission.revision,
        attemptId: attempt.id,
        lease,
        errorCode: 'invalid_motion_path',
        nowMs: this.now(),
      });
      throwIfAborted(signal);
      throw error;
    }
    return this.recordAdmissionPath(artifact, path.dayPath);
  }

  private async recordAdmissionPath(artifact: ArchiveArtifact, dayPath: string): Promise<ArchiveArtifact> {
    if (artifact.admission.motionDayPath === dayPath && artifact.admission.state === 'ready') return artifact;
    return this.repository.recordMotionAdmissionPath(
      artifact.id, artifact.admission.revision, dayPath, this.now(),
    );
  }

  private async resolveContainer(
    artifact: ArchiveArtifact,
    connection: DriveConnection,
    signal: AbortSignal,
  ): Promise<string> {
    if (artifact.kind === 'database_backup') return parentFor(artifact, connection);
    if (this.containerResolver === undefined) {
      throw new DriveConfigurationError('Motion archive container resolver is unavailable');
    }
    return this.containerResolver.execute(connection, MotionArchivePath.parse(artifact.relativePath), signal);
  }

  private async requireUnchangedSource(artifact: ArchiveArtifact, signal: AbortSignal): Promise<void> {
    let source: ArchiveUploadSourceStat;
    try {
      source = await this.source.stat(artifact.trustedPath, signal);
    } catch (error) {
      if (isMissingSource(error)) throw new LocalSourceMissingError();
      throw error;
    }
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
      || (attempt !== undefined && (attempt.generationId !== connection.id
        || (artifact.kind === 'database_backup' && attempt.containerId !== parentFor(artifact, connection))))) {
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

function uploadTarget(artifact: ArchiveArtifact, connection: DriveConnection): {
  fileName: string;
  contentType: string;
  dayPath: string | null;
  directContainerId: string | null;
} {
  if (artifact.kind === 'database_backup') {
    const fileName = artifact.relativePath.split('/').at(-1);
    if (!fileName) throw new DriveConfigurationError('Archive object name is invalid');
    return {
      fileName,
      contentType: 'application/vnd.sqlite3',
      dayPath: null,
      directContainerId: connection.folders!.backupsId,
    };
  }
  const path = MotionArchivePath.parse(artifact.relativePath);
  return {
    fileName: path.fileName,
    contentType: path.contentType,
    dayPath: path.dayPath,
    directContainerId: null,
  };
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
  if (error instanceof LocalSourceMissingError) return 'local_source_missing';
  if (error instanceof DriveLocalSourceChangedError) return 'local_source_changed';
  if (error instanceof DriveObjectConflictError) return 'remote_conflict';
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return 'temporary_failure';
}

function localIdentityErrorCode(
  error: unknown,
): 'local_source_changed' | 'local_source_missing' | null {
  if (error instanceof LocalSourceMissingError) return 'local_source_missing';
  if (error instanceof DriveLocalSourceChangedError) return 'local_source_changed';
  return null;
}

function isMissingSource(error: unknown): boolean {
  return !!error && typeof error === 'object'
    && (error as { code?: unknown }).code === 'ENOENT';
}

function isContainerResolver(
  value: Pick<ResolveMotionArchiveContainerUseCase, 'execute'> | UploadDriveObjectAttemptOptions,
): value is Pick<ResolveMotionArchiveContainerUseCase, 'execute'> {
  return 'execute' in value && typeof value.execute === 'function';
}

class LocalSourceMissingError extends Error {
  constructor() {
    super('Local archive source is missing');
    this.name = 'LocalSourceMissingError';
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}
