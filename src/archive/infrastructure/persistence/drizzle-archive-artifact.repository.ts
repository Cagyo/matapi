import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { AppDatabase, DB } from '../../../database/database.module';
import { archiveArtifacts, archiveSchedulerState, driveObjectAttempts } from '../../../database/schema';
import type {
  ArchiveArtifactRepositoryPort, ArchiveObjectAttempt, ArchiveSchedulerState, ArchiveSchedulerUpdate, AttemptLease, ClaimAttempt,
  ClaimedAttempt, EncryptedUploadSession, ReconciliationSelection, RetentionSelection, VerifiedArchiveObject,
} from '../../application/ports/archive-artifact-repository.port';
import { ArchiveArtifact, type ArchiveArtifactKind, type RegisterArchiveArtifact } from '../../domain/archive-artifact.entity';
import { DriveObjectAttempt, type DriveAttemptState } from '../../domain/drive-object-attempt.entity';
import type { CanonicalSharingState, VerifiedDriveObject } from '../../domain/drive-object-metadata.value-object';
import { DriveAttemptLeaseLostError } from '../../domain/errors/drive-attempt-lease-lost.error';
import { DriveObjectConflictError } from '../../domain/errors/drive-object-conflict.error';

type ArtifactRow = typeof archiveArtifacts.$inferSelect;
type AttemptRow = typeof driveObjectAttempts.$inferSelect;
type Writer = Pick<AppDatabase, 'insert' | 'select' | 'update'>;

/** SQLite manifest adapter. Every lease-owned mutation is expiry- and revision-fenced. */
@Injectable()
export class DrizzleArchiveArtifactRepository implements ArchiveArtifactRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async register(input: RegisterArchiveArtifact): Promise<ArchiveArtifact> {
    const artifact = ArchiveArtifact.register(input, { id: randomUUID(), nowMs: Date.now() });
    try {
      this.db.insert(archiveArtifacts).values(artifactRow(artifact)).run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.findByFingerprint(input.sourceFingerprint);
        if (existing && sameRegistration(existing, input)) return existing;
        throw new DriveObjectConflictError('Archive source fingerprint conflicts with an immutable artifact');
      }
      throw error;
    }
    return artifact;
  }

  async loadArtifact(id: string): Promise<ArchiveArtifact | null> {
    const row = this.db.select().from(archiveArtifacts).where(eq(archiveArtifacts.id, id)).get();
    return row ? toArtifact(row) : null;
  }

  async findByFingerprint(fingerprint: string): Promise<ArchiveArtifact | null> {
    const row = this.db.select().from(archiveArtifacts).where(eq(archiveArtifacts.sourceFingerprint, fingerprint)).get();
    return row ? toArtifact(row) : null;
  }

  async createAttempt(artifactId: string, generationId: string, remoteObjectId: string, containerId: string, nowMs: number): Promise<ArchiveObjectAttempt> {
    if (!this.db.select({ id: archiveArtifacts.id }).from(archiveArtifacts).where(eq(archiveArtifacts.id, artifactId)).get()) {
      throw new DriveObjectConflictError('Archive artifact does not exist');
    }
    const attempt = DriveObjectAttempt.reserve({ id: randomUUID(), artifactId, generationId, remoteFileId: remoteObjectId, parentId: containerId, nowMs });
    try {
      this.db.insert(driveObjectAttempts).values(attemptRow(attempt)).run();
    } catch (error) {
      if (isUniqueViolation(error)) throw new DriveObjectConflictError('Reserved remote object ID already exists');
      throw error;
    }
    return project(attempt, { nextAttemptMs: nowMs, retryCount: 0, errorCode: null, session: null });
  }

  async loadAttempt(attemptId: string): Promise<ArchiveObjectAttempt | null> {
    const row = this.db.select().from(driveObjectAttempts).where(eq(driveObjectAttempts.id, attemptId)).get();
    return row ? projectRow(row) : null;
  }

  async claimAttempt(attemptId: string, input: ClaimAttempt): Promise<ClaimedAttempt> {
    validateClaim(input);
    return this.immediate((tx) => {
      this.recoverExpiredInTransaction(tx, input.nowMs);
      const row = tx.select().from(driveObjectAttempts).where(and(
        eq(driveObjectAttempts.id, attemptId),
        inArray(driveObjectAttempts.state, ['pending', 'retryable']),
        lte(driveObjectAttempts.nextAttemptAt, input.nowMs),
        or(isNull(driveObjectAttempts.leaseExpiresAt), lte(driveObjectAttempts.leaseExpiresAt, input.nowMs)),
      )).get();
      if (!row) throw new DriveAttemptLeaseLostError();
      return this.claim(tx, row, input, true);
    });
  }

  async claimNextAttempt(input: ClaimAttempt): Promise<ClaimedAttempt | null> {
    validateClaim(input);
    return this.immediate((tx) => {
      this.recoverExpiredInTransaction(tx, input.nowMs);
      const row = tx.select({ attempt: driveObjectAttempts, kind: archiveArtifacts.kind }).from(driveObjectAttempts)
        .innerJoin(archiveArtifacts, eq(driveObjectAttempts.artifactId, archiveArtifacts.id))
        .where(and(inArray(driveObjectAttempts.state, ['pending', 'retryable']), lte(driveObjectAttempts.nextAttemptAt, input.nowMs),
          or(isNull(driveObjectAttempts.leaseExpiresAt), lte(driveObjectAttempts.leaseExpiresAt, input.nowMs))))
        .orderBy(asc(queuePriority(input)), asc(driveObjectAttempts.nextAttemptAt), asc(driveObjectAttempts.createdAt), asc(driveObjectAttempts.id))
        .limit(1).get();
      return row ? this.claim(tx, row.attempt, input, true) : null;
    });
  }

  async claimExpiredAttempt(attemptId: string, input: ClaimAttempt): Promise<ClaimedAttempt> {
    validateClaim(input);
    return this.immediate((tx) => {
      const row = tx.select().from(driveObjectAttempts).where(and(eq(driveObjectAttempts.id, attemptId), lte(driveObjectAttempts.leaseExpiresAt, input.nowMs))).get();
      if (!row) throw new DriveAttemptLeaseLostError();
      return this.claim(tx, row, input, false);
    });
  }

  async recoverExpiredLeases(nowMs: number): Promise<number> {
    return this.immediate((tx) => this.recoverExpiredInTransaction(tx, nowMs));
  }

  async renewLease(attemptId: string, lease: AttemptLease, nowMs: number, leaseMs: number): Promise<AttemptLease> {
    validateLeaseDuration(leaseMs);
    const revision = lease.revision + 1;
    const result = this.db.update(driveObjectAttempts).set({ revision, updatedAt: nowMs, leaseExpiresAt: nowMs + leaseMs })
      .where(this.fenced(attemptId, lease, nowMs)).run();
    if (result.changes !== 1) throw new DriveAttemptLeaseLostError();
    return { owner: lease.owner, revision, expiresAtMs: nowMs + leaseMs };
  }

  async saveSession(attemptId: string, lease: AttemptLease, session: EncryptedUploadSession, nowMs: number): Promise<AttemptLease> {
    validateSession(session);
    const revision = lease.revision + 1;
    const result = this.db.update(driveObjectAttempts).set({
      revision, updatedAt: nowMs, sessionCiphertext: session.ciphertext, sessionNonce: session.nonce,
      sessionAuthTag: session.authTag, sessionKeyVersion: session.keyVersion, sessionFormatVersion: session.formatVersion,
      sessionCreatedAt: session.createdAtMs, sessionExpiresAt: session.expiresAtMs, confirmedOffset: session.confirmedOffset,
    }).where(this.fenced(attemptId, lease, nowMs)).run();
    if (result.changes !== 1) throw new DriveAttemptLeaseLostError();
    return { ...lease, revision };
  }

  async confirmOffset(attemptId: string, lease: AttemptLease, offset: number, nowMs: number): Promise<AttemptLease> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new DriveObjectConflictError('Confirmed upload offset is malformed');
    const revision = lease.revision + 1;
    const result = this.db.update(driveObjectAttempts).set({ revision, updatedAt: nowMs, confirmedOffset: offset })
      .where(and(this.fenced(attemptId, lease, nowMs), gte(driveObjectAttempts.sessionExpiresAt, nowMs))).run();
    if (result.changes !== 1) throw new DriveAttemptLeaseLostError();
    return { ...lease, revision };
  }

  async markRetryable(attemptId: string, lease: AttemptLease, errorCode: string, nextAttemptMs: number, nowMs: number): Promise<void> {
    const row = this.requireFencedAttempt(attemptId, lease, nowMs);
    const next = toAttempt(row).markRetryable(nowMs);
    const result = this.db.update(driveObjectAttempts).set({ state: next.state, revision: next.revision, updatedAt: nowMs,
      nextAttemptAt: nextAttemptMs, retryCount: row.retryCount + 1, errorCode, leaseOwner: null, leaseExpiresAt: null }).where(this.fenced(attemptId, lease, nowMs)).run();
    if (result.changes !== 1) throw new DriveAttemptLeaseLostError();
  }

  async markConflict(attemptId: string, lease: AttemptLease, errorCode: string, nowMs: number): Promise<void> {
    const row = this.requireFencedAttempt(attemptId, lease, nowMs);
    const next = toAttempt(row).markConflict(nowMs);
    const result = this.db.update(driveObjectAttempts).set({
      state: next.state,
      revision: next.revision,
      updatedAt: nowMs,
      errorCode,
      leaseOwner: null,
      leaseExpiresAt: null,
      ...clearedSession(),
    }).where(this.fenced(attemptId, lease, nowMs)).run();
    if (result.changes !== 1) throw new DriveAttemptLeaseLostError();
  }

  async markVerified(attemptId: string, lease: AttemptLease, remote: VerifiedArchiveObject, nowMs: number): Promise<void> {
    this.immediate((tx) => {
      const row = tx.select().from(driveObjectAttempts).where(this.fenced(attemptId, lease, nowMs)).get();
      if (!row) throw new DriveAttemptLeaseLostError();
      const attempt = toAttempt(row).verify(toDriveObject(remote), nowMs);
      const artifactRow = tx.select().from(archiveArtifacts).where(eq(archiveArtifacts.id, attempt.artifactId)).get();
      if (!artifactRow) throw new DriveObjectConflictError('Archive artifact does not exist');
      const artifact = toArtifact(artifactRow).markVerified(attempt.id, nowMs);
      const updatedAttempt = tx.update(driveObjectAttempts).set(verifiedAttemptUpdate(attempt))
        .where(this.fenced(attemptId, lease, nowMs)).run();
      if (updatedAttempt.changes !== 1) throw new DriveAttemptLeaseLostError();
      const updatedArtifact = tx.update(archiveArtifacts).set({ state: artifact.state, currentVerifiedAttemptId: artifact.currentVerifiedAttemptId,
        updatedAt: artifact.updatedAtMs, revision: artifact.revision }).where(and(eq(archiveArtifacts.id, artifact.id), eq(archiveArtifacts.revision, artifactRow.revision))).run();
      if (updatedArtifact.changes !== 1) throw new DriveObjectConflictError('Archive artifact changed before verification');
    });
  }

  async markMissing(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void> {
    this.transitionWithoutLease(attemptId, expectedRevision, nowMs, (attempt) => attempt.markMissing(reason, nowMs));
  }

  async markDetached(attemptId: string, expectedRevision: number, reason: string, nowMs: number): Promise<void> {
    this.transitionWithoutLease(attemptId, expectedRevision, nowMs, (attempt) => attempt.detach(reason, nowMs));
  }

  async listAttempts(artifactId: string): Promise<readonly ArchiveObjectAttempt[]> {
    return this.db.select().from(driveObjectAttempts).where(eq(driveObjectAttempts.artifactId, artifactId))
      .orderBy(asc(driveObjectAttempts.createdAt), asc(driveObjectAttempts.id)).all().map(projectRow);
  }

  async listReconciliationBatch(selection: ReconciliationSelection): Promise<readonly ArchiveObjectAttempt[]> {
    validateLimit(selection.limit);
    const conditions = [eq(driveObjectAttempts.state, 'verified')];
    if (selection.generationId) conditions.push(eq(driveObjectAttempts.generationId, selection.generationId));
    return this.db.select().from(driveObjectAttempts).where(and(...conditions))
      .orderBy(asc(driveObjectAttempts.verifiedAt), asc(driveObjectAttempts.id)).limit(selection.limit).all().map(projectRow);
  }

  async listRetentionCandidates(selection: RetentionSelection): Promise<readonly ArchiveObjectAttempt[]> {
    validateLimit(selection.limit);
    const conditions = [eq(driveObjectAttempts.state, 'verified'), eq(archiveArtifacts.kind, selection.kind)];
    if (selection.providerCreatedBeforeMs !== undefined) conditions.push(lte(driveObjectAttempts.verifiedCreatedTime, selection.providerCreatedBeforeMs));
    return this.db.select({ attempt: driveObjectAttempts }).from(driveObjectAttempts)
      .innerJoin(archiveArtifacts, eq(driveObjectAttempts.artifactId, archiveArtifacts.id)).where(and(...conditions))
      .orderBy(asc(driveObjectAttempts.verifiedCreatedTime), asc(driveObjectAttempts.id)).limit(selection.limit).all().map(({ attempt }) => projectRow(attempt));
  }

  async readSchedulerState(): Promise<ArchiveSchedulerState> {
    this.db.insert(archiveSchedulerState).values(schedulerRow(emptySchedulerState())).onConflictDoNothing().run();
    const row = this.db.select().from(archiveSchedulerState).where(eq(archiveSchedulerState.id, 1)).get();
    if (!row) throw new DriveObjectConflictError('Archive scheduler state is missing');
    return toScheduler(row);
  }

  async compareAndSetSchedulerState(expectedRevision: number, update: ArchiveSchedulerUpdate): Promise<boolean> {
    const current = await this.readSchedulerState();
    if (current.revision !== expectedRevision) return false;
    const next = { ...current, ...update, revision: expectedRevision + 1 };
    validateScheduler(next);
    const result = this.db.update(archiveSchedulerState).set(schedulerRow(next))
      .where(and(eq(archiveSchedulerState.id, 1), eq(archiveSchedulerState.revision, expectedRevision))).run();
    return result.changes === 1;
  }

  async releaseGenerationLeases(generationId: string, nowMs: number): Promise<void> {
    this.immediate((tx) => {
      const rows = tx.select().from(driveObjectAttempts).where(and(eq(driveObjectAttempts.generationId, generationId), isNotNull(driveObjectAttempts.leaseOwner))).all();
      for (const row of rows) {
        if (row.leaseOwner === null || row.leaseExpiresAt === null) continue;
        const attempt = toAttempt(row);
        const next = attempt.state === 'uploading' ? attempt.markRetryable(nowMs) : revise(attempt, nowMs);
        const result = tx.update(driveObjectAttempts).set({ state: next.state, revision: next.revision, updatedAt: nowMs,
          nextAttemptAt: attempt.state === 'uploading' ? nowMs : row.nextAttemptAt, retryCount: attempt.state === 'uploading' ? row.retryCount + 1 : row.retryCount,
          leaseOwner: null, leaseExpiresAt: null }).where(and(eq(driveObjectAttempts.id, row.id), eq(driveObjectAttempts.revision, row.revision),
          eq(driveObjectAttempts.leaseOwner, row.leaseOwner), eq(driveObjectAttempts.leaseExpiresAt, row.leaseExpiresAt))).run();
        if (result.changes !== 1) throw new DriveAttemptLeaseLostError();
      }
    });
  }

  async clearGenerationSessions(generationId: string, nowMs: number): Promise<void> {
    this.immediate((tx) => {
      const rows = tx.select().from(driveObjectAttempts)
        .where(and(eq(driveObjectAttempts.generationId, generationId), isNotNull(driveObjectAttempts.sessionCiphertext)))
        .all();
      for (const row of rows) {
        const result = tx.update(driveObjectAttempts).set({
          revision: row.revision + 1,
          updatedAt: nowMs,
          ...clearedSession(),
        }).where(and(eq(driveObjectAttempts.id, row.id), eq(driveObjectAttempts.revision, row.revision))).run();
        if (result.changes !== 1) throw new DriveAttemptLeaseLostError();
      }
    });
  }

  private claim(tx: Writer, row: AttemptRow, input: ClaimAttempt, transition: boolean): ClaimedAttempt {
    const attempt = transition ? toAttempt(row).markUploading(input.nowMs) : revise(toAttempt(row), input.nowMs);
    const result = tx.update(driveObjectAttempts).set({ state: attempt.state, revision: attempt.revision, uploadedAt: attempt.uploadedAtMs,
      updatedAt: attempt.updatedAtMs, leaseOwner: input.owner, leaseExpiresAt: input.nowMs + input.leaseMs })
      .where(and(eq(driveObjectAttempts.id, row.id), eq(driveObjectAttempts.revision, row.revision), transition
        ? and(inArray(driveObjectAttempts.state, ['pending', 'retryable']), or(isNull(driveObjectAttempts.leaseExpiresAt), lte(driveObjectAttempts.leaseExpiresAt, input.nowMs)))
        : lte(driveObjectAttempts.leaseExpiresAt, input.nowMs))).run();
    if (result.changes !== 1) throw new DriveAttemptLeaseLostError();
    const artifact = tx.select().from(archiveArtifacts).where(eq(archiveArtifacts.id, attempt.artifactId)).get();
    if (!artifact) throw new DriveObjectConflictError('Archive artifact does not exist');
    return {
      artifact: toArtifact(artifact),
      attempt: project(attempt, { nextAttemptMs: row.nextAttemptAt, retryCount: row.retryCount, errorCode: row.errorCode, session: sessionFromRow(row) }),
      lease: { owner: input.owner, revision: attempt.revision, expiresAtMs: input.nowMs + input.leaseMs },
    };
  }

  private recoverExpiredInTransaction(tx: Writer, nowMs: number): number {
    const rows = tx.select().from(driveObjectAttempts).where(and(eq(driveObjectAttempts.state, 'uploading'), lte(driveObjectAttempts.leaseExpiresAt, nowMs))).all();
    let recovered = 0;
    for (const row of rows) {
      const next = toAttempt(row).markRetryable(nowMs);
      const result = tx.update(driveObjectAttempts).set({ state: next.state, revision: next.revision, updatedAt: nowMs, nextAttemptAt: nowMs,
        retryCount: row.retryCount + 1, leaseOwner: null, leaseExpiresAt: null }).where(and(eq(driveObjectAttempts.id, row.id), eq(driveObjectAttempts.revision, row.revision),
        eq(driveObjectAttempts.leaseOwner, row.leaseOwner!), eq(driveObjectAttempts.leaseExpiresAt, row.leaseExpiresAt!))).run();
      if (result.changes !== 1) throw new DriveAttemptLeaseLostError();
      recovered += 1;
    }
    return recovered;
  }

  private requireFencedAttempt(attemptId: string, lease: AttemptLease, nowMs: number): AttemptRow {
    const row = this.db.select().from(driveObjectAttempts).where(this.fenced(attemptId, lease, nowMs)).get();
    if (!row) throw new DriveAttemptLeaseLostError();
    return row;
  }

  private transitionWithoutLease(attemptId: string, expectedRevision: number, nowMs: number, transition: (attempt: DriveObjectAttempt) => DriveObjectAttempt): void {
    this.immediate((tx) => {
      const availability = or(isNull(driveObjectAttempts.leaseExpiresAt), lte(driveObjectAttempts.leaseExpiresAt, nowMs));
      const row = tx.select().from(driveObjectAttempts).where(and(eq(driveObjectAttempts.id, attemptId), eq(driveObjectAttempts.revision, expectedRevision), availability)).get();
      if (!row) throw new DriveObjectConflictError('Drive attempt changed before transition');
      const next = transition(toAttempt(row));
      const artifactRow = tx.select().from(archiveArtifacts).where(eq(archiveArtifacts.id, row.artifactId)).get();
      if (!artifactRow) throw new DriveObjectConflictError('Archive artifact does not exist');
      if (artifactRow.currentVerifiedAttemptId === attemptId) {
        const artifact = toArtifact(artifactRow).markCurrentVerificationUnavailable(attemptId, nowMs);
        const updatedArtifact = tx.update(archiveArtifacts).set({ state: artifact.state, currentVerifiedAttemptId: artifact.currentVerifiedAttemptId,
          updatedAt: artifact.updatedAtMs, revision: artifact.revision }).where(and(eq(archiveArtifacts.id, artifact.id), eq(archiveArtifacts.revision, artifactRow.revision))).run();
        if (updatedArtifact.changes !== 1) throw new DriveObjectConflictError('Archive artifact changed before transition');
      }
      const result = tx.update(driveObjectAttempts).set({ state: next.state, revision: next.revision, updatedAt: nowMs,
        missingReason: next.missingReason, detachedReason: next.detachedReason, leaseOwner: null, leaseExpiresAt: null, ...clearedSession() })
        .where(and(eq(driveObjectAttempts.id, attemptId), eq(driveObjectAttempts.revision, expectedRevision), availability)).run();
      if (result.changes !== 1) throw new DriveObjectConflictError('Drive attempt changed before transition');
    });
  }

  private fenced(attemptId: string, lease: AttemptLease, nowMs: number) {
    return and(eq(driveObjectAttempts.id, attemptId), eq(driveObjectAttempts.revision, lease.revision), eq(driveObjectAttempts.leaseOwner, lease.owner),
      eq(driveObjectAttempts.leaseExpiresAt, lease.expiresAtMs), gt(driveObjectAttempts.leaseExpiresAt, nowMs));
  }

  private immediate<T>(operation: (tx: Writer) => T): T {
    return this.db.transaction((tx) => operation(tx), { behavior: 'immediate' });
  }
}

function sameRegistration(artifact: ArchiveArtifact, input: RegisterArchiveArtifact): boolean {
  return artifact.installationId === input.installationId && artifact.kind === input.kind
    && artifact.sourceIdentity === input.sourceIdentity && artifact.trustedPath === input.trustedPath
    && artifact.relativePath === input.relativePath && artifact.size === input.size
    && artifact.mtimeNs === input.mtimeNs && artifact.sourceTimeMs === input.sourceTimeMs
    && artifact.sha256 === input.sha256 && artifact.sourceFingerprint === input.sourceFingerprint;
}

function artifactRow(artifact: ArchiveArtifact) {
  return { id: artifact.id, installationId: artifact.installationId, kind: artifact.kind, sourceIdentity: artifact.sourceIdentity,
    trustedPath: artifact.trustedPath, relativePath: artifact.relativePath, size: artifact.size, mtimeNs: artifact.mtimeNs,
    sourceTimeMs: artifact.sourceTimeMs, sha256: artifact.sha256, sourceFingerprint: artifact.sourceFingerprint, state: artifact.state,
    currentVerifiedAttemptId: artifact.currentVerifiedAttemptId, createdAt: artifact.createdAtMs, updatedAt: artifact.updatedAtMs,
    localDeletedAt: artifact.localDeletedAtMs, revision: artifact.revision };
}

function attemptRow(attempt: DriveObjectAttempt) {
  return { id: attempt.id, artifactId: attempt.artifactId, generationId: attempt.generationId, remoteFileId: attempt.remoteFileId,
    parentId: attempt.parentId, reservedAt: attempt.nowMs, state: attempt.state, revision: attempt.revision, nextAttemptAt: attempt.createdAtMs,
    retryCount: 0, leaseOwner: null, leaseExpiresAt: null, sessionCiphertext: null, sessionNonce: null, sessionAuthTag: null,
    sessionKeyVersion: null, sessionFormatVersion: null, sessionCreatedAt: null, sessionExpiresAt: null, confirmedOffset: null, errorCode: null,
    detachedReason: null, missingReason: null, uploadedAt: null, verifiedAt: null, deletedAt: null, verifiedName: null,
    verifiedMimeType: null, verifiedSize: null, verifiedSha256: null, verifiedMd5: null, verifiedCreatedTime: null,
    verifiedHeadRevisionId: null, verifiedVersion: null, verifiedOwnedByMe: null, verifiedCanDelete: null, verifiedTrashed: null,
    verifiedAppProperties: null, verifiedSharing: null, verifiedWebViewLink: null, createdAt: attempt.createdAtMs, updatedAt: attempt.updatedAtMs };
}

function verifiedAttemptUpdate(attempt: DriveObjectAttempt) {
  const metadata = attempt.verifiedMetadata;
  if (!metadata) throw new DriveObjectConflictError('Drive verification metadata is missing');
  return { state: attempt.state, revision: attempt.revision, updatedAt: attempt.updatedAtMs, verifiedAt: attempt.verifiedAtMs,
    verifiedName: metadata.name, verifiedMimeType: metadata.mimeType, verifiedSize: metadata.size, verifiedSha256: metadata.sha256,
    verifiedMd5: metadata.md5, verifiedCreatedTime: metadata.createdTimeMs, verifiedHeadRevisionId: metadata.headRevisionId,
    verifiedVersion: metadata.version, verifiedOwnedByMe: metadata.ownedByMe, verifiedCanDelete: metadata.canDelete,
    verifiedTrashed: metadata.trashed, verifiedAppProperties: JSON.stringify(metadata.appProperties), verifiedSharing: JSON.stringify(metadata.sharing),
    verifiedWebViewLink: metadata.webViewLink, leaseOwner: null, leaseExpiresAt: null, ...clearedSession() };
}

function clearedSession() {
  return { sessionCiphertext: null, sessionNonce: null, sessionAuthTag: null, sessionKeyVersion: null, sessionFormatVersion: null,
    sessionCreatedAt: null, sessionExpiresAt: null, confirmedOffset: null };
}

function toArtifact(row: ArtifactRow): ArchiveArtifact {
  return ArchiveArtifact.restore({ id: row.id, installationId: row.installationId, kind: row.kind as ArchiveArtifactKind,
    sourceIdentity: row.sourceIdentity, trustedPath: row.trustedPath, relativePath: row.relativePath, size: row.size, mtimeNs: row.mtimeNs,
    sourceTimeMs: row.sourceTimeMs, sha256: row.sha256, sourceFingerprint: row.sourceFingerprint, state: row.state as ArchiveArtifact['state'],
    currentVerifiedAttemptId: row.currentVerifiedAttemptId, createdAtMs: row.createdAt, updatedAtMs: row.updatedAt,
    localDeletedAtMs: row.localDeletedAt, revision: row.revision });
}

function toAttempt(row: AttemptRow): DriveObjectAttempt {
  const verifiedMetadata = row.verifiedAt === null ? null : {
    id: row.remoteFileId, name: required(row.verifiedName), parentId: row.parentId, mimeType: required(row.verifiedMimeType),
    size: required(row.verifiedSize), sha256: required(row.verifiedSha256), md5: row.verifiedMd5, createdTimeMs: required(row.verifiedCreatedTime),
    headRevisionId: required(row.verifiedHeadRevisionId), version: required(row.verifiedVersion), ownedByMe: required(row.verifiedOwnedByMe),
    canDelete: required(row.verifiedCanDelete), trashed: required(row.verifiedTrashed), appProperties: parseRecord(row.verifiedAppProperties),
    sharing: parseSharing(row.verifiedSharing), webViewLink: row.verifiedWebViewLink,
  };
  return DriveObjectAttempt.restore({ id: row.id, artifactId: row.artifactId, generationId: row.generationId, remoteFileId: row.remoteFileId,
    parentId: row.parentId, nowMs: row.reservedAt, state: row.state as DriveAttemptState, verifiedMetadata, detachedReason: row.detachedReason,
    missingReason: row.missingReason, createdAtMs: row.createdAt, updatedAtMs: row.updatedAt, uploadedAtMs: row.uploadedAt,
    verifiedAtMs: row.verifiedAt, deletedAtMs: row.deletedAt, revision: row.revision });
}

function projectRow(row: AttemptRow): ArchiveObjectAttempt {
  return project(toAttempt(row), { nextAttemptMs: row.nextAttemptAt, retryCount: row.retryCount, errorCode: row.errorCode, session: sessionFromRow(row) });
}

function project(attempt: DriveObjectAttempt, persistence: { nextAttemptMs: number; retryCount: number; errorCode: string | null; session: EncryptedUploadSession | null }): ArchiveObjectAttempt {
  const metadata = attempt.verifiedMetadata;
  return {
    id: attempt.id, artifactId: attempt.artifactId, generationId: attempt.generationId, remoteObjectId: attempt.remoteFileId,
    containerId: attempt.parentId, state: attempt.state, createdAtMs: attempt.createdAtMs, updatedAtMs: attempt.updatedAtMs,
    uploadedAtMs: attempt.uploadedAtMs, verifiedAtMs: attempt.verifiedAtMs, deletedAtMs: attempt.deletedAtMs, revision: attempt.revision,
    nextAttemptMs: persistence.nextAttemptMs, retryCount: persistence.retryCount, errorCode: persistence.errorCode,
    detachedReason: attempt.detachedReason, missingReason: attempt.missingReason, session: persistence.session,
    verifiedObject: metadata === null ? null : {
      objectId: metadata.id, name: metadata.name, containerId: metadata.parentId, contentType: metadata.mimeType, size: metadata.size,
      sha256: metadata.sha256, md5: metadata.md5, providerCreatedAtMs: metadata.createdTimeMs, revisionId: metadata.headRevisionId,
      version: metadata.version, ownedByInstallation: metadata.ownedByMe, canDelete: metadata.canDelete, trashed: metadata.trashed,
      attributes: metadata.appProperties, sharing: metadata.sharing, webViewLink: metadata.webViewLink,
    },
  };
}

function sessionFromRow(row: AttemptRow): EncryptedUploadSession | null {
  if (row.sessionCiphertext === null) return null;
  if (row.sessionNonce === null || row.sessionAuthTag === null || row.sessionKeyVersion === null || row.sessionFormatVersion !== 1
    || row.sessionCreatedAt === null || row.sessionExpiresAt === null || row.confirmedOffset === null) {
    throw new DriveObjectConflictError('Persisted upload session is incomplete');
  }
  return { ciphertext: row.sessionCiphertext, nonce: row.sessionNonce, authTag: row.sessionAuthTag, keyVersion: row.sessionKeyVersion,
    formatVersion: 1, createdAtMs: row.sessionCreatedAt, expiresAtMs: row.sessionExpiresAt, confirmedOffset: row.confirmedOffset };
}

function toDriveObject(remote: VerifiedArchiveObject): VerifiedDriveObject {
  return { id: remote.objectId, name: remote.name, parentId: remote.containerId, mimeType: remote.contentType, size: remote.size,
    sha256: remote.sha256, md5: remote.md5, createdTimeMs: remote.providerCreatedAtMs, headRevisionId: remote.revisionId,
    version: remote.version, ownedByMe: remote.ownedByInstallation, canDelete: remote.canDelete, trashed: remote.trashed,
    appProperties: remote.attributes, sharing: remote.sharing, webViewLink: remote.webViewLink };
}

function revise(attempt: DriveObjectAttempt, nowMs: number): DriveObjectAttempt {
  return DriveObjectAttempt.restore({ ...attempt, revision: attempt.revision + 1, updatedAtMs: nowMs });
}

function queuePriority(input: ClaimAttempt) {
  if (input.preferBackups !== false && input.forceVideoRetryBeforeMs !== undefined) {
    return sql<number>`case when ${archiveArtifacts.kind} = 'database_backup' then 0 when ${archiveArtifacts.kind} = 'motion_video' and ${driveObjectAttempts.state} = 'retryable' and ${driveObjectAttempts.nextAttemptAt} <= ${input.forceVideoRetryBeforeMs} then 1 else 2 end`;
  }
  if (input.preferBackups !== false) return sql<number>`case when ${archiveArtifacts.kind} = 'database_backup' then 0 else 1 end`;
  if (input.forceVideoRetryBeforeMs !== undefined) {
    return sql<number>`case when ${archiveArtifacts.kind} = 'motion_video' and ${driveObjectAttempts.state} = 'retryable' and ${driveObjectAttempts.nextAttemptAt} <= ${input.forceVideoRetryBeforeMs} then 0 else 1 end`;
  }
  return sql<number>`0`;
}

function emptySchedulerState(): ArchiveSchedulerState {
  return { revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null, lastBackupSuccessMs: null, lastUploadSuccessMs: null, lastReconcileSuccessMs: null, lastCleanupSuccessMs: null };
}

function schedulerRow(state: ArchiveSchedulerState) {
  return { id: 1, revision: state.revision, backupLeaseOwner: state.backupLeaseOwner, backupLeaseExpiresAt: state.backupLeaseExpiresAtMs,
    lastBackupSuccessMs: state.lastBackupSuccessMs, lastUploadSuccessMs: state.lastUploadSuccessMs,
    lastReconcileSuccessMs: state.lastReconcileSuccessMs, lastCleanupSuccessMs: state.lastCleanupSuccessMs };
}

function toScheduler(row: typeof archiveSchedulerState.$inferSelect): ArchiveSchedulerState {
  return { revision: row.revision, backupLeaseOwner: row.backupLeaseOwner, backupLeaseExpiresAtMs: row.backupLeaseExpiresAt,
    lastBackupSuccessMs: row.lastBackupSuccessMs, lastUploadSuccessMs: row.lastUploadSuccessMs,
    lastReconcileSuccessMs: row.lastReconcileSuccessMs, lastCleanupSuccessMs: row.lastCleanupSuccessMs };
}

function validateClaim(input: ClaimAttempt): void {
  if (!input.owner || !Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new DriveObjectConflictError('Attempt lease is malformed');
  }
}

function validateLeaseDuration(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new DriveObjectConflictError('Attempt lease is malformed');
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new DriveObjectConflictError('Archive selection limit is malformed');
}

function validateSession(session: EncryptedUploadSession): void {
  if (!session.ciphertext || !session.nonce || !session.authTag || session.formatVersion !== 1
    || !Number.isSafeInteger(session.keyVersion) || !Number.isSafeInteger(session.confirmedOffset) || session.confirmedOffset < 0) {
    throw new DriveObjectConflictError('Encrypted upload session is malformed');
  }
}

function validateScheduler(state: ArchiveSchedulerState): void {
  if ((state.backupLeaseOwner === null) !== (state.backupLeaseExpiresAtMs === null)) {
    throw new DriveObjectConflictError('Backup scheduler lease is malformed');
  }
}

function required<T>(value: T | null): T {
  if (value === null) throw new DriveObjectConflictError('Persisted Drive verification metadata is incomplete');
  return value;
}

function parseRecord(value: string | null): Readonly<Record<string, string>> {
  const parsed: unknown = value === null ? null : JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((entry) => typeof entry !== 'string')) {
    throw new DriveObjectConflictError('Persisted Drive app properties are malformed');
  }
  return parsed as Record<string, string>;
}

function parseSharing(value: string | null): CanonicalSharingState {
  const parsed: unknown = value === null ? null : JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DriveObjectConflictError('Persisted Drive sharing metadata is malformed');
  return parsed as CanonicalSharingState;
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}
