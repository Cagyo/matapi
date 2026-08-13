import type { ArchiveArtifactKind, ArchiveArtifact, ArchiveArtifactState, RegisterArchiveArtifact } from '../../domain/archive-artifact.entity';

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
  /** Restrict selection to one artifact class. */
  kind?: ArchiveArtifactKind;
  /** Restrict selection to attempts that have already failed at least once. */
  retryOnly?: boolean;
}

export interface ClaimedAttempt {
  artifact: ArchiveArtifact;
  attempt: ArchiveObjectAttempt;
  lease: AttemptLease;
}

export interface ReplaceAttemptForContainer {
  attemptId: string;
  fence: { kind: 'revision'; revision: number } | { kind: 'lease'; lease: AttemptLease };
  expectedContainerId: string;
  terminalState: 'missing' | 'detached' | 'abandoned';
  errorCode: string;
  replacementRemoteObjectId: string;
  replacementContainerId: string;
  nowMs: number;
}

export interface TerminalizeArtifactAttempt {
  artifactId: string;
  expectedAdmissionRevision: number;
  attemptId: string;
  lease: AttemptLease;
  errorCode: 'local_source_changed' | 'local_source_missing' | 'invalid_motion_path';
  nowMs: number;
}

export interface ReconciliationSelection {
  limit: number;
  generationId?: string;
}

export interface RetentionSelection {
  kind: ArchiveArtifactKind;
  limit: number;
  /** Restrict bounded cleanup selection to the currently manageable generation. */
  generationId?: string;
  /** Inclusive provider-created-time bound used by age-based retention. */
  providerCreatedBeforeMs?: number;
}

export interface UnattemptedArtifactSelection {
  kind: ArchiveArtifactKind;
  limit: number;
  generationId?: string;
  nowMs?: number;
}

export interface ArchiveQueueStatus {
  queuedVideos: number;
  retryableVideos: number;
  oldestQueuedVideoAtMs: number | null;
  branchBlocked: boolean;
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

export interface ArchiveStatusCounts {
  artifacts: Record<ArchiveArtifactState, number>;
  attempts: Record<ArchiveAttemptState, number>;
}

/** Provider-neutral durable archive queue and scheduler state boundary. */
export interface ArchiveArtifactRepositoryPort {
  register(input: RegisterArchiveArtifact): Promise<ArchiveArtifact>;
  loadArtifact(id: string): Promise<ArchiveArtifact | null>;
  findByFingerprint(fingerprint: string): Promise<ArchiveArtifact | null>;
  recordMotionAdmissionPath(artifactId: string, expectedRevision: number, dayPath: string, nowMs: number): Promise<ArchiveArtifact>;
  markAdmissionRetryable(artifactId: string, expectedRevision: number, errorCode: string, nextAttemptMs: number, nowMs: number): Promise<ArchiveArtifact>;
  markAdmissionTerminal(artifactId: string, expectedRevision: number, errorCode: string, nowMs: number): Promise<ArchiveArtifact>;
  createAttempt(artifactId: string, generationId: string, remoteObjectId: string, containerId: string, nowMs: number): Promise<ArchiveObjectAttempt>;
  loadAttempt(attemptId: string): Promise<ArchiveObjectAttempt | null>;
  claimAttempt(attemptId: string, input: ClaimAttempt): Promise<ClaimedAttempt>;
  claimNextAttempt(input: ClaimAttempt): Promise<ClaimedAttempt | null>;
  claimExpiredAttempt(attemptId: string, input: ClaimAttempt): Promise<ClaimedAttempt>;
  recoverExpiredLeases(nowMs: number): Promise<number>;
  renewLease(attemptId: string, lease: AttemptLease, nowMs: number, leaseMs: number): Promise<AttemptLease>;
  saveSession(attemptId: string, lease: AttemptLease, session: EncryptedUploadSession, nowMs: number): Promise<AttemptLease>;
  confirmOffset(attemptId: string, lease: AttemptLease, offset: number, nowMs: number): Promise<AttemptLease>;
  clearSession(attemptId: string, lease: AttemptLease, nowMs: number): Promise<AttemptLease>;
  markRetryable(attemptId: string, lease: AttemptLease, errorCode: string, nextAttemptMs: number, nowMs: number): Promise<void>;
  replaceAttemptForContainer(input: ReplaceAttemptForContainer): Promise<ArchiveObjectAttempt>;
  terminalizeArtifactAttempt(input: TerminalizeArtifactAttempt): Promise<void>;
  replaceConflictingAttempt(attemptId: string, lease: AttemptLease, replacementRemoteObjectId: string, errorCode: string, nowMs: number): Promise<ArchiveObjectAttempt>;
  markVerified(attemptId: string, lease: AttemptLease, remote: VerifiedArchiveObject, nowMs: number): Promise<void>;
  markMissing(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void>;
  /** Atomically terminalizes the old exact ID and persists its already-reserved replacement. */
  replaceMissingWithReservedAttempt(
    attemptId: string,
    expectedRevision: number,
    reason: string,
    replacementRemoteObjectId: string,
    containerId: string,
    nowMs: number,
  ): Promise<ArchiveObjectAttempt>;
  markDetached(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void>;
  /** Records a completed exact-ID permanent deletion after provider success. */
  markDeleted(attemptId: string, expectedRevision: number, nowMs: number): Promise<void>;
  /** Advances the durable fairness order after an exact reconciliation read. */
  markReconciled(attemptId: string, expectedRevision: number, nowMs: number): Promise<void>;
  acceptReconciledRename(attemptId: string, expectedRevision: number, name: string, version: string, nowMs: number): Promise<void>;
  /** Restores one exact managed object without overwriting a terminal historical attempt. */
  adoptVerifiedObject(artifactId: string, generationId: string, remote: VerifiedArchiveObject, nowMs: number): Promise<ArchiveObjectAttempt>;
  listAttempts(artifactId: string): Promise<readonly ArchiveObjectAttempt[]>;
  /** Registered artifacts for which no immutable remote attempt exists yet. */
  listUnattemptedArtifacts(selection: UnattemptedArtifactSelection): Promise<readonly ArchiveArtifact[]>;
  /** Paths whose immutable local bytes must not be pruned before verification. */
  listUnverifiedArtifactPaths(): Promise<readonly string[]>;
  listReconciliationBatch(selection: ReconciliationSelection): Promise<readonly ArchiveObjectAttempt[]>;
  /** Artifacts whose current verification pointer can be recovered from Drive metadata. */
  listRestorationCandidates(limit: number): Promise<readonly ArchiveArtifact[]>;
  listRetentionCandidates(selection: RetentionSelection): Promise<readonly ArchiveObjectAttempt[]>;
  /** Aggregate-only status read; source paths, IDs, metadata, and errors stay private. */
  readStatusCounts(): Promise<ArchiveStatusCounts>;
  readNextDeadline(generationId: string, nowMs: number, providerCooldownUntilMs: number | null): Promise<number | null>;
  readQueueStatus(generationId: string): Promise<ArchiveQueueStatus>;
  readSchedulerState(): Promise<ArchiveSchedulerState>;
  compareAndSetSchedulerState(expectedRevision: number, update: ArchiveSchedulerUpdate): Promise<boolean>;
  releaseGenerationLeases(generationId: string, nowMs: number): Promise<void>;
  clearGenerationSessions(generationId: string, nowMs: number): Promise<void>;
}
