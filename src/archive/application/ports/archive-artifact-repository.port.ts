import type { ArchiveArtifactKind, ArchiveArtifact, RegisterArchiveArtifact } from '../../domain/archive-artifact.entity';

export const ARCHIVE_ARTIFACT_REPOSITORY = Symbol('ARCHIVE_ARTIFACT_REPOSITORY');

export type ArchiveAttemptState =
  | 'pending'
  | 'uploading'
  | 'retryable'
  | 'verified'
  | 'missing'
  | 'detached'
  | 'conflict'
  | 'abandoned'
  | 'deleted';

/** Provider-neutral, encrypted resumable-transfer state. */
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

/** Immutable remote-object snapshot normalized by the persistence adapter. */
export interface VerifiedArchiveObject {
  objectId: string;
  name: string;
  containerId: string;
  contentType: string;
  size: number;
  sha256: string;
  md5: string | null;
  providerCreatedAtMs: number;
  revisionId: string;
  version: string;
  ownedByInstallation: boolean;
  canDelete: boolean;
  trashed: boolean;
  attributes: Readonly<Record<string, string>>;
  sharing: Readonly<{ ownerPermissionId: string; shared: boolean; permissionIds: readonly string[] }>;
  webViewLink: string | null;
}

/**
 * Application-facing projection. Provider-specific entity names and fields are
 * deliberately mapped in persistence infrastructure.
 */
export interface ArchiveObjectAttempt {
  id: string;
  artifactId: string;
  generationId: string;
  remoteObjectId: string;
  containerId: string;
  state: ArchiveAttemptState;
  createdAtMs: number;
  updatedAtMs: number;
  uploadedAtMs: number | null;
  verifiedAtMs: number | null;
  deletedAtMs: number | null;
  revision: number;
  nextAttemptMs: number;
  retryCount: number;
  errorCode: string | null;
  detachedReason: string | null;
  missingReason: string | null;
  session: EncryptedUploadSession | null;
  verifiedObject: VerifiedArchiveObject | null;
}

export interface AttemptLease {
  owner: string;
  revision: number;
  expiresAtMs: number;
}

export interface ClaimAttempt {
  owner: string;
  nowMs: number;
  leaseMs: number;
  /** Give backup artifacts the next available transfer slot. */
  preferBackups?: boolean;
  /** Admit due motion-video retries scheduled no later than this point. */
  forceVideoRetryBeforeMs?: number;
}

export interface ClaimedAttempt {
  artifact: ArchiveArtifact;
  attempt: ArchiveObjectAttempt;
  lease: AttemptLease;
}

export interface ReconciliationSelection {
  limit: number;
  generationId?: string;
}

export interface RetentionSelection {
  kind: ArchiveArtifactKind;
  limit: number;
  /** Inclusive provider-created-time bound used by age-based retention. */
  providerCreatedBeforeMs?: number;
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
  createAttempt(artifactId: string, generationId: string, remoteObjectId: string, containerId: string, nowMs: number): Promise<ArchiveObjectAttempt>;
  loadAttempt(attemptId: string): Promise<ArchiveObjectAttempt | null>;
  claimAttempt(attemptId: string, input: ClaimAttempt): Promise<ClaimedAttempt>;
  claimNextAttempt(input: ClaimAttempt): Promise<ClaimedAttempt | null>;
  claimExpiredAttempt(attemptId: string, input: ClaimAttempt): Promise<ClaimedAttempt>;
  recoverExpiredLeases(nowMs: number): Promise<number>;
  renewLease(attemptId: string, lease: AttemptLease, nowMs: number, leaseMs: number): Promise<AttemptLease>;
  saveSession(attemptId: string, lease: AttemptLease, session: EncryptedUploadSession, nowMs: number): Promise<AttemptLease>;
  confirmOffset(attemptId: string, lease: AttemptLease, offset: number, nowMs: number): Promise<AttemptLease>;
  markRetryable(attemptId: string, lease: AttemptLease, errorCode: string, nextAttemptMs: number, nowMs: number): Promise<void>;
  markConflict(attemptId: string, lease: AttemptLease, errorCode: string, nowMs: number): Promise<void>;
  markVerified(attemptId: string, lease: AttemptLease, remote: VerifiedArchiveObject, nowMs: number): Promise<void>;
  markMissing(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void>;
  markDetached(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void>;
  listAttempts(artifactId: string): Promise<readonly ArchiveObjectAttempt[]>;
  listReconciliationBatch(selection: ReconciliationSelection): Promise<readonly ArchiveObjectAttempt[]>;
  listRetentionCandidates(selection: RetentionSelection): Promise<readonly ArchiveObjectAttempt[]>;
  readSchedulerState(): Promise<ArchiveSchedulerState>;
  compareAndSetSchedulerState(expectedRevision: number, update: ArchiveSchedulerUpdate): Promise<boolean>;
  releaseGenerationLeases(generationId: string, nowMs: number): Promise<void>;
  clearGenerationSessions(generationId: string, nowMs: number): Promise<void>;
}
