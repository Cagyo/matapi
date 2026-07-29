import { randomUUID } from 'node:crypto';
import type {
  ArchiveArtifactRepositoryPort, ArchiveSchedulerState, ArchiveSchedulerUpdate, AttemptLease, ClaimAttempt,
  ClaimedAttempt, EncryptedUploadSession,
} from '../../application/ports/archive-artifact-repository.port';
import { ArchiveArtifact, type ArchiveArtifactKind, type RegisterArchiveArtifact } from '../../domain/archive-artifact.entity';
import { DriveObjectAttempt } from '../../domain/drive-object-attempt.entity';
import type { VerifiedDriveObject } from '../../domain/drive-object-metadata.value-object';
import { DriveAttemptLeaseLostError } from '../../domain/errors/drive-attempt-lease-lost.error';
import { DriveObjectConflictError } from '../../domain/errors/drive-object-conflict.error';

interface Entry {
  attempt: DriveObjectAttempt;
  lease: AttemptLease | null;
  session: EncryptedUploadSession | null;
  nextAttemptMs: number;
  errorCode: string | null;
}

/** In-memory parity adapter for archive use-case tests. */
export class InMemoryArchiveArtifactRepository implements ArchiveArtifactRepositoryPort {
  private readonly artifacts = new Map<string, ArchiveArtifact>();
  private readonly attempts = new Map<string, Entry>();
  private scheduler: ArchiveSchedulerState = emptySchedulerState();

  async register(input: RegisterArchiveArtifact): Promise<ArchiveArtifact> {
    if ([...this.artifacts.values()].some((artifact) => artifact.sourceFingerprint === input.sourceFingerprint)) {
      throw new DriveObjectConflictError('Archive source fingerprint already exists');
    }
    const artifact = ArchiveArtifact.register(input, { id: randomUUID(), nowMs: Date.now() });
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  async loadArtifact(id: string): Promise<ArchiveArtifact | null> {
    return this.artifacts.get(id) ?? null;
  }

  async findByFingerprint(fingerprint: string): Promise<ArchiveArtifact | null> {
    return [...this.artifacts.values()].find((artifact) => artifact.sourceFingerprint === fingerprint) ?? null;
  }

  async createAttempt(artifactId: string, generationId: string, remoteFileId: string, parentId: string, nowMs: number): Promise<DriveObjectAttempt> {
    if (!this.artifacts.has(artifactId)) throw new DriveObjectConflictError('Archive artifact does not exist');
    if ([...this.attempts.values()].some(({ attempt }) => attempt.remoteFileId === remoteFileId)) {
      throw new DriveObjectConflictError('Reserved Drive ID already exists');
    }
    const attempt = DriveObjectAttempt.reserve({ id: randomUUID(), artifactId, generationId, remoteFileId, parentId, nowMs });
    this.attempts.set(attempt.id, { attempt, lease: null, session: null, nextAttemptMs: nowMs, errorCode: null });
    return attempt;
  }

  async claimNextAttempt(input: ClaimAttempt): Promise<ClaimedAttempt | null> {
    const candidate = [...this.attempts.entries()]
      .filter(([, entry]) => (entry.attempt.state === 'pending' || entry.attempt.state === 'retryable')
        && entry.nextAttemptMs <= input.nowMs && (!entry.lease || entry.lease.expiresAtMs <= input.nowMs))
      .sort(([, left], [, right]) => left.attempt.createdAtMs - right.attempt.createdAtMs || left.attempt.id.localeCompare(right.attempt.id))[0];
    if (!candidate) return null;
    return this.claim(candidate[0], candidate[1], input, true);
  }

  async claimExpiredAttempt(attemptId: string, input: ClaimAttempt): Promise<ClaimedAttempt> {
    const entry = this.attempts.get(attemptId);
    if (!entry || !entry.lease || entry.lease.expiresAtMs > input.nowMs) throw new DriveAttemptLeaseLostError();
    return this.claim(attemptId, entry, input, false);
  }

  async renewLease(attemptId: string, lease: AttemptLease, nowMs: number, leaseMs: number): Promise<AttemptLease> {
    const entry = this.requireLease(attemptId, lease, nowMs);
    entry.attempt = revise(entry.attempt, nowMs);
    entry.lease = { owner: lease.owner, revision: entry.attempt.revision, expiresAtMs: nowMs + leaseMs };
    return entry.lease;
  }

  async saveSession(attemptId: string, lease: AttemptLease, session: EncryptedUploadSession): Promise<AttemptLease> {
    const entry = this.requireLease(attemptId, lease);
    entry.attempt = revise(entry.attempt, session.createdAtMs);
    entry.session = { ...session };
    entry.lease = { ...lease, revision: entry.attempt.revision };
    return entry.lease;
  }

  async confirmOffset(attemptId: string, lease: AttemptLease, offset: number, nowMs: number): Promise<AttemptLease> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new DriveObjectConflictError('Confirmed upload offset is malformed');
    const entry = this.requireLease(attemptId, lease, nowMs);
    if (!entry.session) throw new DriveObjectConflictError('Upload session is not stored');
    entry.attempt = revise(entry.attempt, nowMs);
    entry.session = { ...entry.session, confirmedOffset: offset };
    entry.lease = { ...lease, revision: entry.attempt.revision };
    return entry.lease;
  }

  async markRetryable(attemptId: string, lease: AttemptLease, errorCode: string, nextAttemptMs: number): Promise<void> {
    const entry = this.requireLease(attemptId, lease);
    entry.attempt = entry.attempt.markRetryable(nextAttemptMs);
    entry.lease = null;
    entry.errorCode = errorCode;
    entry.nextAttemptMs = nextAttemptMs;
  }

  async markVerified(attemptId: string, lease: AttemptLease, remote: VerifiedDriveObject, nowMs: number): Promise<void> {
    const entry = this.requireLease(attemptId, lease, nowMs);
    const artifact = this.artifacts.get(entry.attempt.artifactId);
    if (!artifact) throw new DriveObjectConflictError('Archive artifact does not exist');
    entry.attempt = entry.attempt.verify(remote, nowMs);
    this.artifacts.set(artifact.id, artifact.markVerified(entry.attempt.id, nowMs));
    entry.lease = null;
  }

  async markMissing(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void> {
    const entry = this.attempts.get(attemptId);
    if (!entry || entry.attempt.revision !== expectedRevision) throw new DriveObjectConflictError('Drive attempt changed before missing transition');
    entry.attempt = entry.attempt.markMissing(reason, nowMs);
    entry.lease = null;
  }

  async markDetached(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void> {
    const entry = this.attempts.get(attemptId);
    if (!entry || entry.attempt.revision !== expectedRevision) throw new DriveObjectConflictError('Drive attempt changed before detach transition');
    entry.attempt = entry.attempt.detach(reason, nowMs);
    entry.lease = null;
  }

  async listAttempts(artifactId: string): Promise<readonly DriveObjectAttempt[]> {
    return [...this.attempts.values()].filter(({ attempt }) => attempt.artifactId === artifactId)
      .sort((left, right) => left.attempt.createdAtMs - right.attempt.createdAtMs || left.attempt.id.localeCompare(right.attempt.id))
      .map(({ attempt }) => attempt);
  }

  async listReconciliationBatch(limit: number): Promise<readonly DriveObjectAttempt[]> {
    return [...this.attempts.values()].filter(({ attempt }) => attempt.state === 'verified')
      .sort((left, right) => left.attempt.verifiedAtMs! - right.attempt.verifiedAtMs!).slice(0, limit).map(({ attempt }) => attempt);
  }

  async listRetentionCandidates(kind: ArchiveArtifactKind, limit: number): Promise<readonly DriveObjectAttempt[]> {
    return [...this.attempts.values()].filter(({ attempt }) => attempt.state === 'verified' && this.artifacts.get(attempt.artifactId)?.kind === kind)
      .sort((left, right) => left.attempt.createdAtMs - right.attempt.createdAtMs).slice(0, limit).map(({ attempt }) => attempt);
  }

  async readSchedulerState(): Promise<ArchiveSchedulerState> {
    return { ...this.scheduler };
  }

  async compareAndSetSchedulerState(expectedRevision: number, update: ArchiveSchedulerUpdate): Promise<boolean> {
    if (this.scheduler.revision !== expectedRevision) return false;
    const next = { ...this.scheduler, ...update, revision: expectedRevision + 1 };
    validateScheduler(next);
    this.scheduler = next;
    return true;
  }

  async releaseGenerationLeases(generationId: string, nowMs: number): Promise<void> {
    for (const entry of this.attempts.values()) {
      if (entry.attempt.generationId !== generationId || !entry.lease) continue;
      entry.attempt = entry.attempt.state === 'uploading' ? entry.attempt.markRetryable(nowMs) : revise(entry.attempt, nowMs);
      entry.lease = null;
      entry.nextAttemptMs = nowMs;
    }
  }

  private claim(id: string, entry: Entry, input: ClaimAttempt, transition: boolean): ClaimedAttempt {
    if (!input.owner || !Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) throw new DriveObjectConflictError('Attempt lease is malformed');
    entry.attempt = transition ? entry.attempt.markUploading(input.nowMs) : revise(entry.attempt, input.nowMs);
    entry.lease = { owner: input.owner, revision: entry.attempt.revision, expiresAtMs: input.nowMs + input.leaseMs };
    const artifact = this.artifacts.get(entry.attempt.artifactId);
    if (!artifact) throw new DriveObjectConflictError('Archive artifact does not exist');
    return { artifact, attempt: entry.attempt, lease: entry.lease };
  }

  private requireLease(attemptId: string, lease: AttemptLease, nowMs?: number): Entry {
    const entry = this.attempts.get(attemptId);
    if (!entry || !entry.lease || entry.lease.owner !== lease.owner || entry.lease.revision !== lease.revision
      || entry.lease.expiresAtMs !== lease.expiresAtMs || (nowMs !== undefined && lease.expiresAtMs < nowMs)) {
      throw new DriveAttemptLeaseLostError();
    }
    return entry;
  }
}

function revise(attempt: DriveObjectAttempt, nowMs: number): DriveObjectAttempt {
  return DriveObjectAttempt.restore({ ...attempt, revision: attempt.revision + 1, updatedAtMs: nowMs });
}

function emptySchedulerState(): ArchiveSchedulerState {
  return { revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null, lastBackupSuccessMs: null, lastUploadSuccessMs: null, lastReconcileSuccessMs: null, lastCleanupSuccessMs: null };
}

function validateScheduler(state: ArchiveSchedulerState): void {
  if ((state.backupLeaseOwner === null) !== (state.backupLeaseExpiresAtMs === null)) throw new DriveObjectConflictError('Backup scheduler lease is malformed');
}
