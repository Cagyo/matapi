import { randomUUID } from 'node:crypto';
import type {
  ArchiveArtifactRepositoryPort, ArchiveObjectAttempt, ArchiveQueueStatus, ArchiveSchedulerState, ArchiveSchedulerUpdate, ArchiveStatusCounts, AttemptLease, ClaimAttempt,
  ClaimedAttempt, EncryptedUploadSession, ReconciliationSelection, ReplaceAttemptForContainer, RetentionSelection, TerminalizeArtifactAttempt,
  UnattemptedArtifactSelection, VerifiedArchiveObject,
} from '../../application/ports/archive-artifact-repository.port';
import type { ArchiveRegistrationLookupInput } from '../../application/ports/archive-registration-lookup.port';
import { ArchiveArtifact, type ArchiveArtifactKind, type RegisterArchiveArtifact } from '../../domain/archive-artifact.entity';
import { DriveObjectAttempt } from '../../domain/drive-object-attempt.entity';
import type { VerifiedDriveObject } from '../../domain/drive-object-metadata.value-object';
import { DriveAttemptLeaseLostError } from '../../domain/errors/drive-attempt-lease-lost.error';
import { DriveObjectConflictError } from '../../domain/errors/drive-object-conflict.error';
import { InMemoryDriveFolderReservationRepository } from './in-memory-drive-folder-reservation.repository';

interface Entry {
  attempt: DriveObjectAttempt;
  lease: AttemptLease | null;
  session: EncryptedUploadSession | null;
  nextAttemptMs: number;
  retryCount: number;
  errorCode: string | null;
}

/** In-memory parity adapter for archive use-case tests. */
export class InMemoryArchiveArtifactRepository implements ArchiveArtifactRepositoryPort {
  private readonly artifacts = new Map<string, ArchiveArtifact>();
  private readonly attempts = new Map<string, Entry>();
  private scheduler: ArchiveSchedulerState = emptySchedulerState();

  constructor(
    private readonly folderReservations = new InMemoryDriveFolderReservationRepository(),
  ) {}

  async register(input: RegisterArchiveArtifact): Promise<ArchiveArtifact> {
    const existing = [...this.artifacts.values()].find((artifact) => artifact.sourceFingerprint === input.sourceFingerprint);
    if (existing) {
      if (sameRegistration(existing, input)) return existing;
      throw new DriveObjectConflictError('Archive source fingerprint conflicts with an immutable artifact');
    }
    const artifact = ArchiveArtifact.register(input, { id: randomUUID(), nowMs: Date.now() });
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  async findRegisteredSource(
    input: ArchiveRegistrationLookupInput,
  ): Promise<{ artifactId: string } | null> {
    const artifact = [...this.artifacts.values()]
      .filter((candidate) => (
        candidate.installationId === input.installationId
        && candidate.kind === input.kind
        && candidate.sourceIdentity === input.sourceIdentity
        && candidate.size === input.size
        && candidate.mtimeNs === input.mtimeNs
      ))
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    return artifact ? { artifactId: artifact.id } : null;
  }

  async loadArtifact(id: string): Promise<ArchiveArtifact | null> {
    return this.artifacts.get(id) ?? null;
  }

  async findByFingerprint(fingerprint: string): Promise<ArchiveArtifact | null> {
    return [...this.artifacts.values()].find((artifact) => artifact.sourceFingerprint === fingerprint) ?? null;
  }

  async recordMotionAdmissionPath(
    artifactId: string,
    expectedRevision: number,
    dayPath: string,
    nowMs: number,
  ): Promise<ArchiveArtifact> {
    return this.transitionAdmission(artifactId, expectedRevision, (artifact) => (
      artifact.recordMotionAdmissionPath(dayPath, nowMs)
    ));
  }

  async markAdmissionRetryable(
    artifactId: string,
    expectedRevision: number,
    errorCode: string,
    nextAttemptMs: number,
    nowMs: number,
  ): Promise<ArchiveArtifact> {
    return this.transitionAdmission(artifactId, expectedRevision, (artifact) => (
      artifact.markAdmissionRetryable(errorCode, nextAttemptMs, nowMs)
    ));
  }

  async markAdmissionTerminal(
    artifactId: string,
    expectedRevision: number,
    errorCode: string,
    nowMs: number,
  ): Promise<ArchiveArtifact> {
    return this.transitionAdmission(artifactId, expectedRevision, (artifact) => (
      artifact.markAdmissionTerminal(errorCode, nowMs)
    ));
  }

  async createAttempt(artifactId: string, generationId: string, remoteObjectId: string, containerId: string, nowMs: number): Promise<ArchiveObjectAttempt> {
    if (!this.artifacts.has(artifactId)) throw new DriveObjectConflictError('Archive artifact does not exist');
    if ([...this.attempts.values()].some(({ attempt }) => attempt.remoteFileId === remoteObjectId)) {
      throw new DriveObjectConflictError('Reserved remote object ID already exists');
    }
    const attempt = DriveObjectAttempt.reserve({ id: randomUUID(), artifactId, generationId, remoteFileId: remoteObjectId, parentId: containerId, nowMs });
    const entry = { attempt, lease: null, session: null, nextAttemptMs: nowMs, retryCount: 0, errorCode: null };
    this.attempts.set(attempt.id, entry);
    return project(entry);
  }

  async loadAttempt(attemptId: string): Promise<ArchiveObjectAttempt | null> {
    const entry = this.attempts.get(attemptId);
    return entry ? project(entry) : null;
  }

  async claimAttempt(attemptId: string, input: ClaimAttempt): Promise<ClaimedAttempt> {
    validateClaim(input);
    this.recoverExpired(input.nowMs);
    const entry = this.attempts.get(attemptId);
    if (!entry || (entry.attempt.state !== 'pending' && entry.attempt.state !== 'retryable')
      || (input.generationId !== undefined && entry.attempt.generationId !== input.generationId)
      || entry.nextAttemptMs > input.nowMs || (entry.lease !== null && entry.lease.expiresAtMs > input.nowMs)) {
      throw new DriveAttemptLeaseLostError();
    }
    return this.claim(attemptId, entry, input, true);
  }

  async claimNextAttempt(input: ClaimAttempt): Promise<ClaimedAttempt | null> {
    validateClaim(input);
    this.recoverExpired(input.nowMs);
    const candidate = [...this.attempts.entries()]
      .filter(([, entry]) => {
        const artifact = this.artifacts.get(entry.attempt.artifactId);
        return (entry.attempt.state === 'pending' || entry.attempt.state === 'retryable')
          && (input.generationId === undefined || entry.attempt.generationId === input.generationId)
          && entry.nextAttemptMs <= input.nowMs
          && (input.kind === undefined || artifact?.kind === input.kind)
          && (!input.retryOnly || entry.attempt.state === 'retryable');
      })
      .sort(([leftId, left], [rightId, right]) => this.queueOrder(leftId, left, rightId, right, input))[0];
    if (!candidate) return null;
    return this.claim(candidate[0], candidate[1], input, true);
  }

  async claimExpiredAttempt(attemptId: string, input: ClaimAttempt): Promise<ClaimedAttempt> {
    validateClaim(input);
    const entry = this.attempts.get(attemptId);
    if (!entry?.lease || entry.lease.expiresAtMs > input.nowMs
      || (input.generationId !== undefined && entry.attempt.generationId !== input.generationId)) {
      throw new DriveAttemptLeaseLostError();
    }
    return this.claim(attemptId, entry, input, false);
  }

  async recoverExpiredLeases(nowMs: number): Promise<number> {
    return this.recoverExpired(nowMs);
  }

  async releaseProcessLeasesAfterRestart(): Promise<number> {
    let released = 0;
    for (const entry of this.attempts.values()) {
      if (entry.lease === null) continue;
      const wasUploading = entry.attempt.state === 'uploading';
      entry.attempt = DriveObjectAttempt.restore({
        ...entry.attempt,
        state: wasUploading ? 'retryable' : entry.attempt.state,
        revision: entry.attempt.revision + 1,
      });
      entry.nextAttemptMs = 0;
      if (wasUploading) entry.retryCount += 1;
      entry.lease = null;
      released += 1;
    }
    return released;
  }

  async renewLease(attemptId: string, lease: AttemptLease, nowMs: number, leaseMs: number): Promise<AttemptLease> {
    const entry = this.requireLease(attemptId, lease, nowMs);
    entry.attempt = revise(entry.attempt, nowMs);
    entry.lease = { owner: lease.owner, revision: entry.attempt.revision, expiresAtMs: nowMs + leaseMs };
    return entry.lease;
  }

  async saveSession(attemptId: string, lease: AttemptLease, session: EncryptedUploadSession, nowMs: number): Promise<AttemptLease> {
    validateSession(session);
    const entry = this.requireLease(attemptId, lease, nowMs);
    entry.attempt = revise(entry.attempt, nowMs);
    entry.session = { ...session };
    entry.lease = { ...lease, revision: entry.attempt.revision };
    return entry.lease;
  }

  async confirmOffset(attemptId: string, lease: AttemptLease, offset: number, nowMs: number): Promise<AttemptLease> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new DriveObjectConflictError('Confirmed upload offset is malformed');
    const entry = this.requireLease(attemptId, lease, nowMs);
    if (!entry.session || entry.session.expiresAtMs < nowMs) throw new DriveAttemptLeaseLostError();
    entry.attempt = revise(entry.attempt, nowMs);
    entry.session = { ...entry.session, confirmedOffset: offset };
    entry.lease = { ...lease, revision: entry.attempt.revision };
    return entry.lease;
  }

  async clearSession(attemptId: string, lease: AttemptLease, nowMs: number): Promise<AttemptLease> {
    const entry = this.requireLease(attemptId, lease, nowMs);
    entry.attempt = revise(entry.attempt, nowMs);
    entry.session = null;
    entry.lease = { ...lease, revision: entry.attempt.revision };
    return entry.lease;
  }

  async markRetryable(attemptId: string, lease: AttemptLease, errorCode: string, nextAttemptMs: number, nowMs: number): Promise<void> {
    const entry = this.requireLease(attemptId, lease, nowMs);
    entry.attempt = entry.attempt.markRetryable(nowMs);
    entry.lease = null;
    entry.errorCode = errorCode;
    entry.nextAttemptMs = nextAttemptMs;
    entry.retryCount += 1;
  }

  async replaceAttemptForContainer(input: ReplaceAttemptForContainer): Promise<ArchiveObjectAttempt> {
    const entry = input.fence.kind === 'lease'
      ? this.requireLease(input.attemptId, input.fence.lease, input.nowMs)
      : this.requireRevisionFence(input.attemptId, input.fence.revision, input.nowMs);
    if (entry.attempt.parentId !== input.expectedContainerId) {
      throw new DriveObjectConflictError('Drive attempt container changed before replacement');
    }
    if ([...this.attempts.values()].some(
      ({ attempt }) => attempt.remoteFileId === input.replacementRemoteObjectId,
    )) {
      throw new DriveObjectConflictError('Reserved remote object ID already exists');
    }
    const artifact = this.artifacts.get(entry.attempt.artifactId);
    if (!artifact) throw new DriveObjectConflictError('Archive artifact does not exist');
    const terminal = terminalizeAttempt(entry.attempt, input.terminalState, input.errorCode, input.nowMs);
    const replacement = DriveObjectAttempt.reserve({
      id: randomUUID(),
      artifactId: entry.attempt.artifactId,
      generationId: entry.attempt.generationId,
      remoteFileId: input.replacementRemoteObjectId,
      parentId: input.replacementContainerId,
      nowMs: input.nowMs,
    });
    const replacementEntry: Entry = {
      attempt: replacement,
      lease: null,
      session: null,
      nextAttemptMs: input.nowMs,
      retryCount: 0,
      errorCode: null,
    };
    entry.attempt = terminal;
    entry.lease = null;
    entry.session = null;
    entry.errorCode = input.errorCode;
    if (artifact.currentVerifiedAttemptId === entry.attempt.id) {
      this.artifacts.set(
        artifact.id,
        artifact.markCurrentVerificationUnavailable(entry.attempt.id, input.nowMs),
      );
    }
    this.attempts.set(replacement.id, replacementEntry);
    return project(replacementEntry);
  }

  async terminalizeArtifactAttempt(input: TerminalizeArtifactAttempt): Promise<void> {
    const entry = this.requireLease(input.attemptId, input.lease, input.nowMs);
    if (entry.attempt.artifactId !== input.artifactId) {
      throw new DriveObjectConflictError('Drive attempt does not belong to the archive artifact');
    }
    const artifact = this.artifacts.get(input.artifactId);
    if (artifact?.admission.revision !== input.expectedAdmissionRevision) {
      throw new DriveObjectConflictError('Archive admission changed before terminalization');
    }
    const terminalArtifact = artifact.markAdmissionTerminal(input.errorCode, input.nowMs);
    const terminalAttempt = entry.attempt.abandon(input.nowMs);
    this.artifacts.set(artifact.id, terminalArtifact);
    entry.attempt = terminalAttempt;
    entry.lease = null;
    entry.session = null;
    entry.errorCode = input.errorCode;
  }

  async replaceConflictingAttempt(
    attemptId: string,
    lease: AttemptLease,
    replacementRemoteObjectId: string,
    errorCode: string,
    nowMs: number,
  ): Promise<ArchiveObjectAttempt> {
    const entry = this.requireLease(attemptId, lease, nowMs);
    if ([...this.attempts.values()].some(({ attempt }) => attempt.remoteFileId === replacementRemoteObjectId)) {
      throw new DriveObjectConflictError('Reserved remote object ID already exists');
    }
    const replacement = DriveObjectAttempt.reserve({
      id: randomUUID(),
      artifactId: entry.attempt.artifactId,
      generationId: entry.attempt.generationId,
      remoteFileId: replacementRemoteObjectId,
      parentId: entry.attempt.parentId,
      nowMs,
    });
    const conflict = entry.attempt.markConflict(nowMs);
    const replacementEntry: Entry = {
      attempt: replacement, lease: null, session: null, nextAttemptMs: nowMs, retryCount: 0, errorCode: null,
    };
    entry.attempt = conflict;
    entry.lease = null;
    entry.session = null;
    entry.errorCode = errorCode;
    this.attempts.set(replacement.id, replacementEntry);
    return project(replacementEntry);
  }

  async markVerified(attemptId: string, lease: AttemptLease, remote: VerifiedArchiveObject, nowMs: number): Promise<void> {
    const entry = this.requireLease(attemptId, lease, nowMs);
    const artifact = this.artifacts.get(entry.attempt.artifactId);
    if (!artifact) throw new DriveObjectConflictError('Archive artifact does not exist');
    entry.attempt = entry.attempt.verify(toDriveObject(remote), nowMs);
    entry.session = null;
    entry.lease = null;
    this.artifacts.set(artifact.id, artifact.markVerified(entry.attempt.id, nowMs));
  }

  async markMissing(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void> {
    this.transitionWithoutLease(attemptId, expectedRevision, nowMs, (attempt) => attempt.markMissing(reason, nowMs));
  }

  async replaceMissingWithReservedAttempt(
    attemptId: string,
    expectedRevision: number,
    reason: string,
    replacementRemoteObjectId: string,
    containerId: string,
    nowMs: number,
  ): Promise<ArchiveObjectAttempt> {
    const entry = this.attempts.get(attemptId);
    if (entry?.attempt.revision !== expectedRevision
      || (entry.lease?.expiresAtMs ?? -1) > nowMs) {
      throw new DriveObjectConflictError('Drive attempt changed before missing replacement');
    }
    if ([...this.attempts.values()].some(
      ({ attempt }) => attempt.remoteFileId === replacementRemoteObjectId,
    )) {
      throw new DriveObjectConflictError('Reserved remote object ID already exists');
    }
    const artifact = this.artifacts.get(entry.attempt.artifactId);
    if (artifact?.currentVerifiedAttemptId !== attemptId) {
      throw new DriveObjectConflictError('Archive artifact changed before missing replacement');
    }
    const missing = entry.attempt.markMissing(reason, nowMs);
    const replacement = DriveObjectAttempt.reserve({
      id: randomUUID(),
      artifactId: artifact.id,
      generationId: entry.attempt.generationId,
      remoteFileId: replacementRemoteObjectId,
      parentId: containerId,
      nowMs,
    });
    const replacementEntry: Entry = {
      attempt: replacement,
      lease: null,
      session: null,
      nextAttemptMs: nowMs,
      retryCount: 0,
      errorCode: null,
    };
    entry.attempt = missing;
    entry.lease = null;
    entry.session = null;
    this.artifacts.set(
      artifact.id,
      artifact.markCurrentVerificationUnavailable(attemptId, nowMs),
    );
    this.attempts.set(replacement.id, replacementEntry);
    return project(replacementEntry);
  }

  async markDetached(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void> {
    this.transitionWithoutLease(attemptId, expectedRevision, nowMs, (attempt) => attempt.detach(reason, nowMs));
  }

  async markDeleted(attemptId: string, expectedRevision: number, nowMs: number): Promise<void> {
    this.transitionWithoutLease(attemptId, expectedRevision, nowMs, (attempt) => attempt.markDeleted(nowMs));
  }

  async markReconciled(
    attemptId: string,
    expectedRevision: number,
    nowMs: number,
  ): Promise<void> {
    const entry = this.attempts.get(attemptId);
    if (entry?.attempt.state !== 'verified'
      || entry.attempt.revision !== expectedRevision
      || (entry.lease?.expiresAtMs ?? -1) > nowMs) {
      throw new DriveObjectConflictError('Drive attempt changed before reconciliation');
    }
    const newestInGeneration = Math.max(...[...this.attempts.values()]
      .filter(({ attempt }) => attempt.state === 'verified'
        && attempt.generationId === entry.attempt.generationId)
      .map(({ attempt }) => attempt.updatedAtMs));
    entry.attempt = revise(entry.attempt, Math.max(nowMs, newestInGeneration + 1));
  }

  async acceptReconciledRename(
    attemptId: string,
    expectedRevision: number,
    name: string,
    version: string,
    nowMs: number,
  ): Promise<void> {
    const entry = this.attempts.get(attemptId);
    if (entry?.attempt.revision !== expectedRevision
      || (entry.lease?.expiresAtMs ?? -1) > nowMs) {
      throw new DriveObjectConflictError('Drive attempt changed before rename acceptance');
    }
    entry.attempt = entry.attempt.acceptPresentationRename(name, version, nowMs);
  }

  async adoptVerifiedObject(
    artifactId: string,
    generationId: string,
    remote: VerifiedArchiveObject,
    nowMs: number,
  ): Promise<ArchiveObjectAttempt> {
    const artifact = this.artifacts.get(artifactId);
    if (artifact?.currentVerifiedAttemptId !== null) {
      throw new DriveObjectConflictError('Archive artifact changed before restoration');
    }
    let entry = [...this.attempts.values()].find(
      ({ attempt }) => attempt.remoteFileId === remote.objectId,
    );
    if (entry !== undefined) {
      if (entry.attempt.artifactId !== artifactId
        || entry.attempt.generationId !== generationId
        || entry.attempt.parentId !== remote.containerId
        || !['pending', 'retryable', 'uploading'].includes(entry.attempt.state)
        || (entry.lease?.expiresAtMs ?? -1) > nowMs) {
        throw new DriveObjectConflictError('Restored Drive object conflicts with immutable history');
      }
    } else {
      const attempt = DriveObjectAttempt.reserve({
        id: randomUUID(),
        artifactId,
        generationId,
        remoteFileId: remote.objectId,
        parentId: remote.containerId,
        nowMs,
      });
      entry = {
        attempt,
        lease: null,
        session: null,
        nextAttemptMs: nowMs,
        retryCount: 0,
        errorCode: null,
      };
      this.attempts.set(attempt.id, entry);
    }
    entry.attempt = entry.attempt.verify(toDriveObject(remote), nowMs);
    entry.lease = null;
    entry.session = null;
    this.artifacts.set(artifact.id, artifact.markVerified(entry.attempt.id, nowMs));
    return project(entry);
  }

  async listAttempts(artifactId: string): Promise<readonly ArchiveObjectAttempt[]> {
    return [...this.attempts.values()].filter(({ attempt }) => attempt.artifactId === artifactId)
      .sort((left, right) => left.attempt.createdAtMs - right.attempt.createdAtMs || left.attempt.id.localeCompare(right.attempt.id))
      .map(project);
  }

  async listUnattemptedArtifacts(selection: UnattemptedArtifactSelection): Promise<readonly ArchiveArtifact[]> {
    validateLimit(selection.limit);
    const nowMs = selection.nowMs ?? Date.now();
    const attempted = new Set([...this.attempts.values()]
      .filter(({ attempt }) => selection.generationId === undefined
        || attempt.generationId === selection.generationId)
      .map(({ attempt }) => attempt.artifactId));
    const eligible: ArchiveArtifact[] = [];
    for (const artifact of this.artifacts.values()) {
      if (artifact.kind !== selection.kind || artifact.state !== 'pending' || attempted.has(artifact.id)
        || artifact.admission.state === 'terminal'
        || artifact.admission.nextAttemptMs > nowMs) continue;
      if (selection.generationId !== undefined
        && await this.isBlocked(artifact, selection.generationId)) continue;
      eligible.push(artifact);
    }
    return eligible
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id))
      .slice(0, selection.limit);
  }

  async listUnverifiedArtifactPaths(): Promise<readonly string[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.state !== 'verified')
      .map((artifact) => artifact.trustedPath);
  }

  async listReconciliationBatch(selection: ReconciliationSelection): Promise<readonly ArchiveObjectAttempt[]> {
    return [...this.attempts.values()]
      .filter(({ attempt }) => attempt.state === 'verified' && (!selection.generationId || attempt.generationId === selection.generationId))
      .sort((left, right) => left.attempt.updatedAtMs - right.attempt.updatedAtMs || left.attempt.id.localeCompare(right.attempt.id))
      .slice(0, selection.limit).map(project);
  }

  async listRestorationCandidates(limit: number): Promise<readonly ArchiveArtifact[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.state === 'pending'
        && artifact.currentVerifiedAttemptId === null
        && artifact.admission.state !== 'terminal')
      .sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  async listRetentionCandidates(selection: RetentionSelection): Promise<readonly ArchiveObjectAttempt[]> {
    return [...this.attempts.values()]
      .filter(({ attempt }) => attempt.state === 'verified' && this.artifacts.get(attempt.artifactId)?.kind === selection.kind
        && (selection.generationId === undefined || attempt.generationId === selection.generationId)
        && (selection.providerCreatedBeforeMs === undefined || attempt.verifiedMetadata!.createdTimeMs <= selection.providerCreatedBeforeMs))
      .sort((left, right) => left.attempt.verifiedMetadata!.createdTimeMs - right.attempt.verifiedMetadata!.createdTimeMs || left.attempt.id.localeCompare(right.attempt.id))
      .slice(0, selection.limit).map(project);
  }

  async readStatusCounts(): Promise<ArchiveStatusCounts> {
    const artifacts: ArchiveStatusCounts['artifacts'] = {
      stabilizing: 0, pending: 0, verified: 0, local_missing: 0, superseded: 0,
    };
    const attempts: ArchiveStatusCounts['attempts'] = {
      pending: 0, uploading: 0, retryable: 0, verified: 0, missing: 0,
      detached: 0, conflict: 0, abandoned: 0, deleted: 0,
    };
    for (const artifact of this.artifacts.values()) artifacts[artifact.state] += 1;
    for (const { attempt } of this.attempts.values()) attempts[attempt.state] += 1;
    return { artifacts, attempts };
  }

  readNextDeadline(input: {
    generationId: string;
    nowMs: number;
    providerDeadlineMs: number | null;
  }): Promise<number | null>;
  readNextDeadline(
    generationId: string,
    nowMs: number,
    providerDeadlineMs: number | null,
  ): Promise<number | null>;
  async readNextDeadline(
    inputOrGenerationId: {
      generationId: string;
      nowMs: number;
      providerDeadlineMs: number | null;
    } | string,
    legacyNowMs?: number,
    legacyProviderDeadlineMs?: number | null,
  ): Promise<number | null> {
    const { generationId, nowMs, providerDeadlineMs } = typeof inputOrGenerationId === 'string'
      ? {
          generationId: inputOrGenerationId,
          nowMs: legacyNowMs!,
          providerDeadlineMs: legacyProviderDeadlineMs ?? null,
        }
      : inputOrGenerationId;
    const attempted = new Set([...this.attempts.values()]
      .filter(({ attempt }) => attempt.generationId === generationId)
      .map(({ attempt }) => attempt.artifactId));
    const deadlines: number[] = [];
    if (providerDeadlineMs !== null && providerDeadlineMs > nowMs) {
      deadlines.push(providerDeadlineMs);
    }
    for (const artifact of this.artifacts.values()) {
      if (artifact.kind === 'motion_video' && artifact.state === 'pending'
        && artifact.admission.state === 'retryable' && artifact.admission.nextAttemptMs > nowMs
        && !attempted.has(artifact.id)) {
        deadlines.push(artifact.admission.nextAttemptMs);
      }
    }
    for (const { attempt } of this.attempts.values()) {
      const entry = this.attempts.get(attempt.id)!;
      if (attempt.generationId === generationId && ['pending', 'retryable'].includes(attempt.state)
        && entry.nextAttemptMs > nowMs) deadlines.push(entry.nextAttemptMs);
    }
    for (const reservation of this.folderReservations.history()) {
      if (reservation.generationId === generationId
        && reservation.currentSlot === 1
        && (reservation.state === 'detached' || reservation.state === 'conflict')
        && reservation.nextRevalidationAtMs !== null
        && reservation.nextRevalidationAtMs > nowMs) {
        deadlines.push(reservation.nextRevalidationAtMs);
      }
    }
    return deadlines.length === 0 ? null : Math.min(...deadlines);
  }

  async readNextEligibleTransferSize(
    generationId: string,
    nowMs: number,
    forceVideoRetryBeforeMs?: number,
  ): Promise<number | null> {
    const dueAttemptSize = (
      kind: ArchiveArtifactKind,
      retryBeforeMs?: number,
    ): number | null => {
      const candidate = [...this.attempts.entries()]
        .filter(([, entry]) => entry.attempt.generationId === generationId
          && ['pending', 'retryable'].includes(entry.attempt.state)
          && entry.nextAttemptMs <= nowMs
          && (retryBeforeMs === undefined
            || (entry.attempt.state === 'retryable' && entry.nextAttemptMs <= retryBeforeMs))
          && this.artifacts.get(entry.attempt.artifactId)?.kind === kind)
        .sort(([leftId, left], [rightId, right]) => left.nextAttemptMs - right.nextAttemptMs
          || left.attempt.createdAtMs - right.attempt.createdAtMs || leftId.localeCompare(rightId))[0];
      return candidate === undefined
        ? null
        : this.artifacts.get(candidate[1].attempt.artifactId)?.size ?? null;
    };
    const dueBackupAttempt = dueAttemptSize('database_backup');
    if (dueBackupAttempt !== null) return dueBackupAttempt;
    const [newBackup] = await this.listUnattemptedArtifacts({
      kind: 'database_backup', generationId, nowMs, limit: 1,
    });
    if (newBackup !== undefined) return newBackup.size;
    const forcedVideoRetry = forceVideoRetryBeforeMs === undefined
      ? null
      : dueAttemptSize('motion_video', forceVideoRetryBeforeMs);
    if (forcedVideoRetry !== null) return forcedVideoRetry;
    const [newVideo] = await this.listUnattemptedArtifacts({
      kind: 'motion_video', generationId, nowMs, limit: 1,
    });
    return newVideo?.size ?? dueAttemptSize('motion_video');
  }

  async readQueueStatus(generationId: string, nowMs?: number): Promise<ArchiveQueueStatus> {
    const queued = [...this.artifacts.values()].filter((artifact) => (
      artifact.kind === 'motion_video' && artifact.state === 'pending'
      && artifact.admission.state !== 'terminal'
    ));
    const retryableArtifactIds = new Set(
      queued.filter((artifact) => artifact.admission.state === 'retryable')
        .map((artifact) => artifact.id),
    );
    const queuedArtifactIds = new Set(queued.map((artifact) => artifact.id));
    for (const { attempt } of this.attempts.values()) {
      if (attempt.generationId === generationId && attempt.state === 'retryable'
        && queuedArtifactIds.has(attempt.artifactId)) {
        retryableArtifactIds.add(attempt.artifactId);
      }
    }
    const blockedByArtifact = new Map<string, boolean>();
    for (const artifact of queued) {
      blockedByArtifact.set(artifact.id, await this.isBlocked(artifact, generationId));
    }
    const anyBlocked = [...blockedByArtifact.values()].some(Boolean);
    const hasHealthyDueCandidate = nowMs === undefined ? false : queued.some((artifact) => {
      if (blockedByArtifact.get(artifact.id) === true) return false;
      const attempts = [...this.attempts.values()].filter(({ attempt }) => (
        attempt.artifactId === artifact.id && attempt.generationId === generationId
      ));
      if (attempts.length === 0) return artifact.admission.nextAttemptMs <= nowMs;
      return attempts.some(({ attempt, nextAttemptMs }) => (
        ['pending', 'retryable'].includes(attempt.state)
        && nextAttemptMs <= nowMs
      ));
    });
    return {
      queuedVideos: queued.length,
      retryableVideos: retryableArtifactIds.size,
      oldestQueuedVideoAtMs: queued.length === 0
        ? null
        : Math.min(...queued.map((artifact) => artifact.createdAtMs)),
      branchBlocked: anyBlocked && (nowMs === undefined || !hasHealthyDueCandidate),
    };
  }

  async readUnhealthyDateFolderCount(generationId: string): Promise<number> {
    return this.folderReservations.countUnhealthy(generationId);
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
      if (entry.attempt.state === 'uploading') {
        entry.attempt = entry.attempt.markRetryable(nowMs);
        entry.retryCount += 1;
        entry.nextAttemptMs = nowMs;
      } else {
        entry.attempt = revise(entry.attempt, nowMs);
      }
      entry.lease = null;
    }
  }

  async clearGenerationSessions(generationId: string, nowMs: number): Promise<void> {
    for (const entry of this.attempts.values()) {
      if (entry.attempt.generationId !== generationId || entry.session === null) continue;
      entry.attempt = revise(entry.attempt, nowMs);
      entry.session = null;
    }
  }

  private claim(id: string, entry: Entry, input: ClaimAttempt, transition: boolean): ClaimedAttempt {
    entry.attempt = transition ? entry.attempt.markUploading(input.nowMs) : revise(entry.attempt, input.nowMs);
    entry.lease = { owner: input.owner, revision: entry.attempt.revision, expiresAtMs: input.nowMs + input.leaseMs };
    const artifact = this.artifacts.get(entry.attempt.artifactId);
    if (!artifact) throw new DriveObjectConflictError('Archive artifact does not exist');
    return { artifact, attempt: project(entry), lease: entry.lease };
  }

  private recoverExpired(nowMs: number): number {
    let recovered = 0;
    for (const entry of this.attempts.values()) {
      if (entry.attempt.state !== 'uploading' || !entry.lease || entry.lease.expiresAtMs > nowMs) continue;
      entry.attempt = entry.attempt.markRetryable(nowMs);
      entry.lease = null;
      entry.nextAttemptMs = nowMs;
      entry.retryCount += 1;
      recovered += 1;
    }
    return recovered;
  }

  private queueOrder(leftId: string, left: Entry, rightId: string, right: Entry, input: ClaimAttempt): number {
    const leftPriority = this.queuePriority(left, input);
    const rightPriority = this.queuePriority(right, input);
    return leftPriority - rightPriority || left.nextAttemptMs - right.nextAttemptMs
      || left.attempt.createdAtMs - right.attempt.createdAtMs || leftId.localeCompare(rightId);
  }

  private queuePriority(entry: Entry, input: ClaimAttempt): number {
    const kind = this.artifacts.get(entry.attempt.artifactId)?.kind;
    if (input.preferBackups !== false && kind === 'database_backup') return 0;
    if (input.forceVideoRetryBeforeMs !== undefined && kind === 'motion_video' && entry.attempt.state === 'retryable'
      && entry.nextAttemptMs <= input.forceVideoRetryBeforeMs) return 1;
    return 2;
  }

  private transitionWithoutLease(attemptId: string, expectedRevision: number, nowMs: number, transition: (attempt: DriveObjectAttempt) => DriveObjectAttempt): void {
    const entry = this.attempts.get(attemptId);
    if (entry?.attempt.revision !== expectedRevision || (entry.lease?.expiresAtMs ?? -1) > nowMs) {
      throw new DriveObjectConflictError('Drive attempt changed before transition');
    }
    entry.attempt = transition(entry.attempt);
    entry.lease = null;
    entry.session = null;
    const artifact = this.artifacts.get(entry.attempt.artifactId);
    if (!artifact) throw new DriveObjectConflictError('Archive artifact does not exist');
    this.artifacts.set(artifact.id, artifact.markCurrentVerificationUnavailable(entry.attempt.id, nowMs));
  }

  private requireLease(attemptId: string, lease: AttemptLease, nowMs: number): Entry {
    const entry = this.attempts.get(attemptId);
    if (entry?.lease?.owner !== lease.owner || entry.lease.revision !== lease.revision
      || entry.lease.expiresAtMs !== lease.expiresAtMs || lease.expiresAtMs <= nowMs) {
      throw new DriveAttemptLeaseLostError();
    }
    return entry;
  }

  private requireRevisionFence(attemptId: string, revision: number, nowMs: number): Entry {
    const entry = this.attempts.get(attemptId);
    if (entry?.attempt.revision !== revision || (entry.lease?.expiresAtMs ?? -1) > nowMs) {
      throw new DriveObjectConflictError('Drive attempt changed before replacement');
    }
    return entry;
  }

  private transitionAdmission(
    artifactId: string,
    expectedRevision: number,
    transition: (artifact: ArchiveArtifact) => ArchiveArtifact,
  ): ArchiveArtifact {
    const artifact = this.artifacts.get(artifactId);
    if (artifact?.admission.revision !== expectedRevision) {
      throw new DriveObjectConflictError('Archive admission changed before transition');
    }
    const next = transition(artifact);
    this.artifacts.set(artifactId, next);
    return next;
  }

  private async isBlocked(artifact: ArchiveArtifact, generationId: string): Promise<boolean> {
    if (artifact.admission.motionDayPath === null) return false;
    for (const prefix of dayPathPrefixes(artifact.admission.motionDayPath)) {
      const head = await this.folderReservations.loadCurrent(generationId, prefix);
      if (head !== null && ['detached', 'conflict'].includes(head.state)) return true;
    }
    return false;
  }
}

function sameRegistration(artifact: ArchiveArtifact, input: RegisterArchiveArtifact): boolean {
  return artifact.installationId === input.installationId && artifact.kind === input.kind
    && artifact.sourceIdentity === input.sourceIdentity && artifact.trustedPath === input.trustedPath
    && artifact.relativePath === input.relativePath && artifact.size === input.size
    && artifact.mtimeNs === input.mtimeNs && artifact.sourceTimeMs === input.sourceTimeMs
    && artifact.sha256 === input.sha256 && artifact.sourceFingerprint === input.sourceFingerprint;
}

function project(entry: Entry): ArchiveObjectAttempt {
  const attempt = entry.attempt;
  const metadata = attempt.verifiedMetadata;
  return {
    id: attempt.id, artifactId: attempt.artifactId, generationId: attempt.generationId, remoteObjectId: attempt.remoteFileId,
    containerId: attempt.parentId, state: attempt.state, createdAtMs: attempt.createdAtMs, updatedAtMs: attempt.updatedAtMs,
    uploadedAtMs: attempt.uploadedAtMs, verifiedAtMs: attempt.verifiedAtMs, deletedAtMs: attempt.deletedAtMs, revision: attempt.revision,
    nextAttemptMs: entry.nextAttemptMs, retryCount: entry.retryCount, errorCode: entry.errorCode, detachedReason: attempt.detachedReason,
    missingReason: attempt.missingReason, session: entry.session ? { ...entry.session } : null,
    verifiedObject: metadata === null ? null : {
      objectId: metadata.id, name: metadata.name, containerId: metadata.parentId, contentType: metadata.mimeType, size: metadata.size,
      sha256: metadata.sha256, md5: metadata.md5, providerCreatedAtMs: metadata.createdTimeMs, revisionId: metadata.headRevisionId,
      version: metadata.version, ownedByInstallation: metadata.ownedByMe, canDelete: metadata.canDelete, trashed: metadata.trashed,
      attributes: metadata.appProperties, sharing: metadata.sharing, webViewLink: metadata.webViewLink,
    },
  };
}

function toDriveObject(remote: VerifiedArchiveObject): VerifiedDriveObject {
  return {
    id: remote.objectId, name: remote.name, parentId: remote.containerId, mimeType: remote.contentType, size: remote.size,
    sha256: remote.sha256, md5: remote.md5, createdTimeMs: remote.providerCreatedAtMs, headRevisionId: remote.revisionId,
    version: remote.version, ownedByMe: remote.ownedByInstallation, canDelete: remote.canDelete, trashed: remote.trashed,
    appProperties: remote.attributes, sharing: remote.sharing, webViewLink: remote.webViewLink,
  };
}

function revise(attempt: DriveObjectAttempt, nowMs: number): DriveObjectAttempt {
  return DriveObjectAttempt.restore({ ...attempt, revision: attempt.revision + 1, updatedAtMs: nowMs });
}

function emptySchedulerState(): ArchiveSchedulerState {
  return {
    revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null,
    lastBackupSuccessMs: null, lastUploadSuccessMs: null,
    lastReconcileSuccessMs: null, lastCleanupSuccessMs: null,
    lastMotionTraversalSuccessMs: null,
    lastArtifactRegistrationSuccessMs: null,
    lastPlausibleWallTimeMs: null,
    clockHealth: 'healthy',
    observedRollbackMs: null,
  };
}

function validateClaim(input: ClaimAttempt): void {
  if (!input.owner || !Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new DriveObjectConflictError('Attempt lease is malformed');
  }
  if (input.generationId?.length === 0) {
    throw new DriveObjectConflictError('Attempt lease generation is malformed');
  }
}

function validateSession(session: EncryptedUploadSession): void {
  if (!session.ciphertext || !session.nonce || !session.authTag || session.formatVersion !== 1
    || !Number.isSafeInteger(session.keyVersion) || !Number.isSafeInteger(session.confirmedOffset) || session.confirmedOffset < 0) {
    throw new DriveObjectConflictError('Encrypted upload session is malformed');
  }
}

function validateScheduler(state: ArchiveSchedulerState): void {
  if ((state.backupLeaseOwner === null) !== (state.backupLeaseExpiresAtMs === null)) throw new DriveObjectConflictError('Backup scheduler lease is malformed');
  if (state.lastPlausibleWallTimeMs !== null && (!Number.isSafeInteger(state.lastPlausibleWallTimeMs) || state.lastPlausibleWallTimeMs < 0)) {
    throw new DriveObjectConflictError('Archive scheduler plausible wall time is malformed');
  }
  if (!['healthy', 'clock-blocked'].includes(state.clockHealth)) throw new DriveObjectConflictError('Archive scheduler clock health is malformed');
  if (state.observedRollbackMs !== null && (!Number.isSafeInteger(state.observedRollbackMs) || state.observedRollbackMs < 0)) {
    throw new DriveObjectConflictError('Archive scheduler observed rollback is malformed');
  }
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new DriveObjectConflictError('Archive selection limit is malformed');
  }
}

function dayPathPrefixes(dayPath: string): readonly string[] {
  const segments = dayPath.split('/');
  return [segments[0], segments.slice(0, 2).join('/'), dayPath];
}

function terminalizeAttempt(
  attempt: DriveObjectAttempt,
  state: ReplaceAttemptForContainer['terminalState'],
  reason: string,
  nowMs: number,
): DriveObjectAttempt {
  if (state === 'missing') return attempt.markMissing(reason, nowMs);
  if (state === 'detached') return attempt.detach(reason, nowMs);
  return attempt.abandon(nowMs);
}
