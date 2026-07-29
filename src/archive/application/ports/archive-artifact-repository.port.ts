import type { ArchiveArtifactKind, ArchiveArtifact, RegisterArchiveArtifact } from '../../domain/archive-artifact.entity';
import type { DriveObjectAttempt } from '../../domain/drive-object-attempt.entity';
import type { VerifiedDriveObject } from '../../domain/drive-object-metadata.value-object';

export const ARCHIVE_ARTIFACT_REPOSITORY = Symbol('ARCHIVE_ARTIFACT_REPOSITORY');

export interface AttemptLease {
  owner: string;
  revision: number;
  expiresAtMs: number;
}

export interface ClaimAttempt {
  owner: string;
  nowMs: number;
  leaseMs: number;
}

export interface ClaimedAttempt {
  artifact: ArchiveArtifact;
  attempt: DriveObjectAttempt;
  lease: AttemptLease;
}

export interface EncryptedUploadSession {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
  formatVersion: 1;
  createdAtMs: number;
  expiresAtMs: number;
  confirmedOffset: number;
}

export interface ArchiveSchedulerState {
  revision: number;
  backupLeaseOwner: string | null;
  backupLeaseExpiresAtMs: number | null;
  lastBackupSuccessMs: number | null;
  lastUploadSuccessMs: number | null;
  lastReconcileSuccessMs: number | null;
  lastCleanupSuccessMs: number | null;
}

export interface ArchiveSchedulerUpdate {
  backupLeaseOwner?: string | null;
  backupLeaseExpiresAtMs?: number | null;
  lastBackupSuccessMs?: number | null;
  lastUploadSuccessMs?: number | null;
  lastReconcileSuccessMs?: number | null;
  lastCleanupSuccessMs?: number | null;
}

/** Provider-neutral durable archive queue and scheduler state boundary. */
export interface ArchiveArtifactRepositoryPort {
  register(input: RegisterArchiveArtifact): Promise<ArchiveArtifact>;
  loadArtifact(id: string): Promise<ArchiveArtifact | null>;
  findByFingerprint(fingerprint: string): Promise<ArchiveArtifact | null>;
  createAttempt(artifactId: string, generationId: string, remoteFileId: string, parentId: string, nowMs: number): Promise<DriveObjectAttempt>;
  claimNextAttempt(input: ClaimAttempt): Promise<ClaimedAttempt | null>;
  claimExpiredAttempt(attemptId: string, input: ClaimAttempt): Promise<ClaimedAttempt>;
  renewLease(attemptId: string, lease: AttemptLease, nowMs: number, leaseMs: number): Promise<AttemptLease>;
  saveSession(attemptId: string, lease: AttemptLease, session: EncryptedUploadSession): Promise<AttemptLease>;
  confirmOffset(attemptId: string, lease: AttemptLease, offset: number, nowMs: number): Promise<AttemptLease>;
  markRetryable(attemptId: string, lease: AttemptLease, errorCode: string, nextAttemptMs: number): Promise<void>;
  markVerified(attemptId: string, lease: AttemptLease, remote: VerifiedDriveObject, nowMs: number): Promise<void>;
  markMissing(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void>;
  markDetached(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void>;
  listAttempts(artifactId: string): Promise<readonly DriveObjectAttempt[]>;
  listReconciliationBatch(limit: number): Promise<readonly DriveObjectAttempt[]>;
  listRetentionCandidates(kind: ArchiveArtifactKind, limit: number): Promise<readonly DriveObjectAttempt[]>;
  readSchedulerState(): Promise<ArchiveSchedulerState>;
  compareAndSetSchedulerState(expectedRevision: number, update: ArchiveSchedulerUpdate): Promise<boolean>;
  releaseGenerationLeases(generationId: string, nowMs: number): Promise<void>;
}
