import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/database/schema';
import type { DriveFolderReservationRepositoryPort } from '../../../src/archive/application/ports/drive-folder-reservation-repository.port';
import { DriveAttemptLeaseLostError } from '../../../src/archive/domain/errors/drive-attempt-lease-lost.error';
import { DrizzleArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/drizzle-archive-artifact.repository';
import { DrizzleDriveFolderReservationRepository } from '../../../src/archive/infrastructure/persistence/drizzle-drive-folder-reservation.repository';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';

describe('DrizzleArchiveArtifactRepository', () => {
  let sqlite: Database.Database;
  let repository: DrizzleArchiveArtifactRepository;
  let folderReservations: DrizzleDriveFolderReservationRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    repository = new DrizzleArchiveArtifactRepository(db);
    folderReservations = new DrizzleDriveFolderReservationRepository(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });

  it('persists immutable admission transitions and fences stale revisions', async () => {
    const artifact = await repository.register(artifactFixture());
    const admitted = await repository.recordMotionAdmissionPath(
      artifact.id, 0, '2026/08/13', 100,
    );
    const retryable = await repository.markAdmissionRetryable(
      artifact.id, admitted.admission.revision, 'temporary', 500, 101,
    );

    expect(await repository.loadArtifact(artifact.id)).toMatchObject({
      admission: {
        state: 'retryable', motionDayPath: '2026/08/13', nextAttemptMs: 500,
        errorCode: 'temporary', revision: 2,
      },
    });
    await expect(repository.recordMotionAdmissionPath(
      artifact.id, retryable.admission.revision, '2026/08/14', 102,
    )).rejects.toThrow('immutable');
    await expect(repository.markAdmissionTerminal(
      artifact.id, 1, 'stale', 103,
    )).rejects.toThrow('changed');
  });

  it('runs admission read-transition-write inside one real immediate transaction', async () => {
    let updateObservedInTransaction: boolean | null = null;
    sqlite.function('observe_admission_transaction', () => {
      updateObservedInTransaction = sqlite.inTransaction;
      return 1;
    });
    sqlite.exec(`
      create temp trigger observe_archive_admission_transaction
      before update of admission_revision on archive_artifacts
      begin
        select observe_admission_transaction();
      end
    `);
    const artifact = await repository.register(artifactFixture());

    const admitted = await repository.recordMotionAdmissionPath(
      artifact.id, 0, '2026/08/13', 100,
    );

    expect(updateObservedInTransaction).toBe(true);
    expect(await repository.loadArtifact(artifact.id)).toEqual(admitted);
  });

  it('rejects admission transitions for database backups without persisting changes', async () => {
    const backup = await repository.register({
      ...artifactFixture(),
      kind: 'database_backup',
      sourceIdentity: 'backup-admission',
      sourceFingerprint: '0'.repeat(64),
    });

    await expect(repository.recordMotionAdmissionPath(
      backup.id, 0, '2026/08/13', 10,
    )).rejects.toThrow(/motion video/iu);
    await expect(repository.markAdmissionRetryable(
      backup.id, 0, 'temporary', 500, 11,
    )).rejects.toThrow(/motion video/iu);
    await expect(repository.markAdmissionTerminal(
      backup.id, 0, 'invalid', 12,
    )).rejects.toThrow(/motion video/iu);
    expect(await repository.loadArtifact(backup.id)).toMatchObject({
      admission: {
        state: 'ready', motionDayPath: null, nextAttemptMs: 0,
        errorCode: null, revision: 0,
      },
    });
  });

  it('filters blocked branches before applying the bounded selection limit', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2);
    const blocked = await repository.register({
      ...artifactFixture(),
      sourceIdentity: 'blocked',
      relativePath: '2026/08/13/blocked.mp4',
      sourceFingerprint: 'c'.repeat(64),
    });
    await repository.recordMotionAdmissionPath(blocked.id, 0, '2026/08/13', 10);
    const healthy = await repository.register({
      ...artifactFixture(),
      sourceIdentity: 'healthy',
      relativePath: '2026/08/14/healthy.mp4',
      sourceFingerprint: 'd'.repeat(64),
    });
    await repository.recordMotionAdmissionPath(healthy.id, 0, '2026/08/14', 11);
    await seedBlockedPath(folderReservations, 'generation-1', '2026/08/13', 'detached');

    expect(await repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId: 'generation-1', nowMs: 100, limit: 1,
    })).toMatchObject([{ id: healthy.id }]);
  });

  it('filters an artifact whose current year ancestor is blocked', async () => {
    const blocked = await repository.register({
      ...artifactFixture(), sourceIdentity: 'blocked-year',
      relativePath: '2026/08/13/blocked.mp4', sourceFingerprint: 'c'.repeat(64),
    });
    await repository.recordMotionAdmissionPath(blocked.id, 0, '2026/08/13', 10);
    const healthy = await repository.register({
      ...artifactFixture(), sourceIdentity: 'healthy-year',
      relativePath: '2027/08/13/healthy.mp4', sourceFingerprint: 'd'.repeat(64),
    });
    await repository.recordMotionAdmissionPath(healthy.id, 0, '2027/08/13', 11);
    await seedBlockedPath(
      folderReservations, 'generation-1', '2026/08/13', 'conflict', 'year',
    );

    expect(await repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId: 'generation-1', nowMs: 100, limit: 5,
    })).toMatchObject([{ id: healthy.id }]);
  });

  it('keeps null paths eligible and compares blocked prefixes without LIKE wildcards', async () => {
    const wildcard = await repository.register({
      ...artifactFixture(),
      sourceIdentity: 'wildcard',
      relativePath: '2026/%_/15/wildcard.mp4',
      sourceFingerprint: 'e'.repeat(64),
    });
    await repository.recordMotionAdmissionPath(wildcard.id, 0, '2026/%_/15', 10);
    const unparsed = await repository.register({
      ...artifactFixture(),
      sourceIdentity: 'unparsed',
      relativePath: 'unparsed.mp4',
      sourceFingerprint: 'f'.repeat(64),
    });
    await seedBlockedPath(folderReservations, 'generation-1', '2026/08/15', 'conflict');

    expect((await repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId: 'generation-1', nowMs: 100, limit: 5,
    })).map((artifact) => artifact.id)).toEqual(expect.arrayContaining([wildcard.id, unparsed.id]));
  });

  it('persists terminal filtering, all queue deadlines, and aggregate queue status', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(30);
    const blocked = await repository.register({
      ...artifactFixture(), sourceIdentity: 'blocked-status',
      relativePath: '2026/08/16/blocked.mp4', sourceFingerprint: 'c'.repeat(64),
    });
    await repository.recordMotionAdmissionPath(blocked.id, 0, '2026/08/16', 40);
    const retryable = await repository.register({
      ...artifactFixture(), sourceIdentity: 'retryable-status',
      sourceFingerprint: 'd'.repeat(64),
    });
    await repository.markAdmissionRetryable(retryable.id, 0, 'temporary', 500, 41);
    const attempted = await repository.register({
      ...artifactFixture(), sourceIdentity: 'attempted-status',
      sourceFingerprint: 'e'.repeat(64),
    });
    const attempt = await repository.createAttempt(
      attempted.id, 'generation-1', 'file-deadline', 'folder-1', 42,
    );
    const claim = await repository.claimAttempt(attempt.id, {
      owner: 'worker', nowMs: 50, leaseMs: 10,
    });
    await repository.markRetryable(attempt.id, claim.lease, 'temporary', 350, 51);
    await repository.markAdmissionTerminal(attempted.id, 0, 'invalid', 52);
    await seedBlockedPath(folderReservations, 'generation-1', '2026/08/16', 'detached');

    expect(await repository.readNextDeadline('generation-1', 100, 400)).toBe(350);
    expect(await repository.readNextDeadline('other-generation', 100, null)).toBe(500);
    expect(await repository.readNextDeadline('other-generation', 100, 400)).toBe(400);
    expect(await repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId: 'generation-1', nowMs: 100, limit: 10,
    })).toEqual([]);
    expect(await repository.readQueueStatus('generation-1')).toEqual({
      queuedVideos: 2,
      retryableVideos: 1,
      oldestQueuedVideoAtMs: 10,
      branchBlocked: true,
    });
  });

  it('keeps historical attempt IDs after replacement', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);

    await repository.markMissing(first.id, first.revision, 'remote_missing', 101);
    await repository.createAttempt(artifact.id, 'generation-1', 'file-2', 'folder-1', 102);

    expect((await repository.listAttempts(artifact.id)).map((attempt) => attempt.remoteObjectId))
      .toEqual(['file-1', 'file-2']);
  });

  it('atomically terminalizes a conflict with its already-generated replacement', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const claim = await repository.claimAttempt(first.id, { owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });

    const replacement = await repository.replaceConflictingAttempt(
      first.id, claim.lease, 'file-2', 'reserved_id_conflict', 1_100,
    );

    expect(replacement).toMatchObject({ remoteObjectId: 'file-2', state: 'pending' });
    expect((await repository.listAttempts(artifact.id)).map((attempt) => [attempt.remoteObjectId, attempt.state]))
      .toEqual([['file-1', 'conflict'], ['file-2', 'pending']]);
  });

  it('rolls back conflict terminalization when replacement persistence fails', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    await repository.createAttempt(artifact.id, 'generation-1', 'file-2', 'folder-1', 101);
    const claim = await repository.claimAttempt(first.id, { owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });

    await expect(repository.replaceConflictingAttempt(
      first.id, claim.lease, 'file-2', 'reserved_id_conflict', 1_100,
    )).rejects.toThrow();

    expect((await repository.loadAttempt(first.id))).toMatchObject({ state: 'uploading' });
    await expect(repository.claimAttempt(first.id, { owner: 'worker-b', nowMs: 6_000, leaseMs: 5_000 }))
      .resolves.toMatchObject({ lease: { owner: 'worker-b' } });
  });

  it('atomically replaces an immutable attempt container and clears the old session', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(
      artifact.id, 'generation-1', 'file-1', 'old-day-folder', 100,
    );
    const claim = await repository.claimAttempt(first.id, {
      owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000,
    });
    const lease = await repository.saveSession(
      first.id, claim.lease, sessionFixture(1_100), 1_100,
    );

    const replacement = await repository.replaceAttemptForContainer({
      attemptId: first.id,
      fence: { kind: 'lease', lease },
      expectedContainerId: 'old-day-folder',
      terminalState: 'missing',
      errorCode: 'container_replaced',
      replacementRemoteObjectId: 'file-2',
      replacementContainerId: 'new-day-folder',
      nowMs: 1_200,
    });

    expect(replacement).toMatchObject({
      remoteObjectId: 'file-2', containerId: 'new-day-folder', state: 'pending',
      nextAttemptMs: 1_200,
    });
    expect(await repository.loadAttempt(first.id)).toMatchObject({
      containerId: 'old-day-folder', state: 'missing', session: null,
      errorCode: 'container_replaced',
    });
  });

  it('rejects a stale container-replacement revision without changing the attempt', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(
      artifact.id, 'generation-1', 'file-1', 'old-day-folder', 100,
    );

    await expect(repository.replaceAttemptForContainer({
      attemptId: first.id,
      fence: { kind: 'revision', revision: first.revision + 1 },
      expectedContainerId: 'old-day-folder',
      terminalState: 'missing',
      errorCode: 'container_missing',
      replacementRemoteObjectId: 'stale-file',
      replacementContainerId: 'new-day-folder',
      nowMs: 200,
    })).rejects.toThrow('changed');
    expect(await repository.loadAttempt(first.id)).toMatchObject({
      state: 'pending', containerId: 'old-day-folder',
    });
    expect(await repository.listAttempts(artifact.id)).toHaveLength(1);
  });

  it('accepts the exact revision fence while preserving the old immutable container', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(
      artifact.id, 'generation-1', 'file-1', 'old-day-folder', 100,
    );

    const replacement = await repository.replaceAttemptForContainer({
      attemptId: first.id,
      fence: { kind: 'revision', revision: first.revision },
      expectedContainerId: 'old-day-folder',
      terminalState: 'missing',
      errorCode: 'container_missing',
      replacementRemoteObjectId: 'file-2',
      replacementContainerId: 'new-day-folder',
      nowMs: 201,
    });

    expect(replacement).toMatchObject({
      remoteObjectId: 'file-2', containerId: 'new-day-folder', state: 'pending',
    });
    expect(await repository.loadAttempt(first.id)).toMatchObject({
      state: 'missing', containerId: 'old-day-folder',
    });
  });

  it('rolls back container terminalization and session clearing when replacement insertion fails', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(
      artifact.id, 'generation-1', 'file-1', 'old-day-folder', 100,
    );
    await repository.createAttempt(
      artifact.id, 'generation-1', 'file-2', 'new-day-folder', 101,
    );
    const claim = await repository.claimAttempt(first.id, {
      owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000,
    });
    const lease = await repository.saveSession(
      first.id, claim.lease, sessionFixture(1_100), 1_100,
    );

    await expect(repository.replaceAttemptForContainer({
      attemptId: first.id,
      fence: { kind: 'lease', lease },
      expectedContainerId: 'old-day-folder',
      terminalState: 'missing',
      errorCode: 'container_replaced',
      replacementRemoteObjectId: 'file-2',
      replacementContainerId: 'new-day-folder',
      nowMs: 1_200,
    })).rejects.toThrow('Reserved remote object ID already exists');

    expect(await repository.loadAttempt(first.id)).toMatchObject({
      containerId: 'old-day-folder', state: 'uploading', session: sessionFixture(1_100),
      errorCode: null,
    });
  });

  it('atomically terminalizes one local-source attempt and its artifact admission', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(
      artifact.id, 'generation-1', 'file-1', 'day-folder', 100,
    );
    const claim = await repository.claimAttempt(first.id, {
      owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000,
    });
    const lease = await repository.saveSession(
      first.id, claim.lease, sessionFixture(1_100), 1_100,
    );

    await repository.terminalizeArtifactAttempt({
      artifactId: artifact.id,
      expectedAdmissionRevision: artifact.admission.revision,
      attemptId: first.id,
      lease,
      errorCode: 'local_source_missing',
      nowMs: 1_200,
    });

    expect(await repository.loadArtifact(artifact.id)).toMatchObject({
      admission: { state: 'terminal', errorCode: 'local_source_missing' },
    });
    expect(await repository.loadAttempt(first.id)).toMatchObject({
      state: 'abandoned', session: null, errorCode: 'local_source_missing',
    });
  });

  it('rolls back exact-attempt terminalization when the artifact admission CAS is stale', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(
      artifact.id, 'generation-1', 'file-1', 'day-folder', 100,
    );
    const claim = await repository.claimAttempt(first.id, {
      owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000,
    });
    const lease = await repository.saveSession(
      first.id, claim.lease, sessionFixture(1_100), 1_100,
    );
    await repository.markAdmissionRetryable(
      artifact.id, artifact.admission.revision, 'provider_cooldown', 9_000, 1_150,
    );

    await expect(repository.terminalizeArtifactAttempt({
      artifactId: artifact.id,
      expectedAdmissionRevision: artifact.admission.revision,
      attemptId: first.id,
      lease,
      errorCode: 'local_source_changed',
      nowMs: 1_200,
    })).rejects.toThrow('changed');

    expect(await repository.loadArtifact(artifact.id)).toMatchObject({
      admission: {
        state: 'retryable', errorCode: 'provider_cooldown', nextAttemptMs: 9_000,
      },
    });
    expect(await repository.loadAttempt(first.id)).toMatchObject({
      state: 'uploading', session: sessionFixture(1_100), errorCode: null,
    });
  });

  it('rolls back a missing transition when its reserved replacement cannot be inserted', async () => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(
      artifact.id,
      'generation-1',
      'file-1',
      'folder-1',
      100,
    );
    const claim = await repository.claimAttempt(first.id, {
      owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000,
    });
    await repository.markVerified(
      first.id,
      claim.lease,
      verifiedObject('file-1', 'folder-1'),
      1_100,
    );
    const other = await repository.register({
      ...artifactFixture(),
      sourceIdentity: 'camera-2',
      trustedPath: '/var/lib/home-worker/motion/other.mp4',
      relativePath: 'motion/other.mp4',
      sourceFingerprint: 'd'.repeat(64),
    });
    await repository.createAttempt(
      other.id,
      'generation-1',
      'file-2',
      'folder-1',
      1_150,
    );
    const verified = await repository.loadAttempt(first.id);
    if (!verified) throw new Error('expected verified attempt');

    await expect(repository.replaceMissingWithReservedAttempt(
      first.id,
      verified.revision,
      'remote_missing',
      'file-2',
      'folder-1',
      1_200,
    )).rejects.toThrow('Reserved remote object ID already exists');

    expect(await repository.loadAttempt(first.id)).toMatchObject({ state: 'verified' });
    expect(await repository.loadArtifact(artifact.id)).toMatchObject({
      state: 'verified',
      currentVerifiedAttemptId: first.id,
    });
  });

  it('moves an exact reconciliation behind newer verified attempts despite clock rollback', async () => {
    const firstArtifact = await repository.register(artifactFixture());
    const secondArtifact = await repository.register({
      ...artifactFixture(),
      sourceIdentity: 'camera-2',
      trustedPath: '/var/lib/home-worker/motion/other.mp4',
      relativePath: 'motion/other.mp4',
      sourceFingerprint: 'd'.repeat(64),
    });
    const first = await repository.createAttempt(
      firstArtifact.id, 'generation-1', 'file-1', 'folder-1', 100,
    );
    const second = await repository.createAttempt(
      secondArtifact.id, 'generation-1', 'file-2', 'folder-1', 101,
    );
    const firstClaim = await repository.claimAttempt(first.id, {
      owner: 'worker-a', nowMs: 1_000, leaseMs: 100_000,
    });
    const secondClaim = await repository.claimAttempt(second.id, {
      owner: 'worker-b', nowMs: 1_001, leaseMs: 100_000,
    });
    await repository.markVerified(
      first.id, firstClaim.lease, verifiedObject('file-1', 'folder-1'), 10_000,
    );
    await repository.markVerified(
      second.id, secondClaim.lease, verifiedObject('file-2', 'folder-1'), 20_000,
    );
    const [selected] = await repository.listReconciliationBatch({
      generationId: 'generation-1', limit: 1,
    });

    await repository.markReconciled(selected.id, selected.revision, 500);

    expect((await repository.listReconciliationBatch({
      generationId: 'generation-1', limit: 1,
    }))[0].remoteObjectId).toBe('file-2');
  });

  it('returns the existing immutable artifact for a concurrent duplicate registration', async () => {
    const input = artifactFixture();

    const [first, second] = await Promise.all([
      repository.register(input),
      repository.register(input),
    ]);

    expect(first.id).toBe(second.id);
    expect(await repository.findByFingerprint(input.sourceFingerprint)).toMatchObject({ id: first.id });
  });

  it('prevents an expired lease owner from verifying an attempt', async () => {
    const artifact = await repository.register(artifactFixture());
    await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const firstClaim = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!firstClaim) throw new Error('expected claim');

    await repository.claimExpiredAttempt(firstClaim.attempt.id, { owner: 'worker-b', nowMs: 7_000, leaseMs: 5_000 });

    await expect(repository.markVerified(firstClaim.attempt.id, firstClaim.lease, verifiedObject('file-1', 'folder-1'), 7_100))
      .rejects.toBeInstanceOf(DriveAttemptLeaseLostError);
  });

  it('persists a complete verification snapshot and fences stale scheduler writers', async () => {
    const artifact = await repository.register(artifactFixture());
    await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const claim = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!claim) throw new Error('expected claim');

    await repository.markVerified(claim.attempt.id, claim.lease, verifiedObject('file-1', 'folder-1'), 1_100);

    const verified = (await repository.listAttempts(artifact.id))[0];
    expect(verified).toMatchObject({ state: 'verified', verifiedObject: { objectId: 'file-1', containerId: 'folder-1' } });
    const state = await repository.readSchedulerState();
    expect(await repository.compareAndSetSchedulerState(state.revision, { lastUploadSuccessMs: 1_100 })).toBe(true);
    expect(await repository.compareAndSetSchedulerState(state.revision, { lastUploadSuccessMs: 1_200 })).toBe(false);
  });

  it('returns a persisted resumable session and clears it when verification terminalizes the attempt', async () => {
    const artifact = await repository.register(artifactFixture());
    await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const claim = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!claim) throw new Error('expected claim');

    const lease = await repository.saveSession(claim.attempt.id, claim.lease, sessionFixture(1_100), 1_100);
    const resumed = await repository.claimExpiredAttempt(claim.attempt.id, { owner: 'worker-b', nowMs: 6_000, leaseMs: 5_000 });

    expect(resumed).toMatchObject({ attempt: { session: sessionFixture(1_100) } });
    await repository.markVerified(resumed.attempt.id, resumed.lease, verifiedObject('file-1', 'folder-1'), 6_100);
    expect((await repository.listAttempts(artifact.id))[0]).toMatchObject({ session: null });
    expect(lease.revision).toBeGreaterThan(claim.lease.revision);
  });

  it.each(['missing', 'detached'] as const)('allows a verified artifact to receive a replacement after its old object is %s', async (terminalState) => {
    const artifact = await repository.register(artifactFixture());
    const first = await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const firstClaim = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!firstClaim) throw new Error('expected first claim');
    await repository.markVerified(firstClaim.attempt.id, firstClaim.lease, verifiedObject('file-1', 'folder-1'), 1_100);

    const verified = (await repository.listAttempts(artifact.id))[0];
    if (terminalState === 'missing') {
      await repository.markMissing(first.id, verified.revision, 'remote_missing', 1_200);
    } else {
      await repository.markDetached(first.id, verified.revision, 'remote_detached', 1_200);
    }
    await repository.createAttempt(artifact.id, 'generation-1', 'file-2', 'folder-1', 1_300);
    const replacement = await repository.claimNextAttempt({ owner: 'worker-b', nowMs: 1_300, leaseMs: 5_000 });
    if (!replacement) throw new Error('expected replacement claim');

    await expect(repository.markVerified(replacement.attempt.id, replacement.lease, verifiedObject('file-2', 'folder-1'), 1_400))
      .resolves.toBeUndefined();
  });

  it('recovers an expired uploading lease globally when selecting the next attempt', async () => {
    const artifact = await repository.register(artifactFixture());
    await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const first = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!first) throw new Error('expected first claim');

    const recovered = await repository.claimNextAttempt({ owner: 'worker-b', nowMs: 6_000, leaseMs: 5_000 });

    expect(recovered).toMatchObject({ attempt: { id: first.attempt.id, state: 'uploading' }, lease: { owner: 'worker-b' } });
  });

  it('rejects every lease-owned write after the lease expires', async () => {
    const artifact = await repository.register(artifactFixture());
    await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const claim = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!claim) throw new Error('expected claim');

    const savedLease = await repository.saveSession(claim.attempt.id, claim.lease, sessionFixture(1_100), 1_100);

    await expect(repository.renewLease(claim.attempt.id, savedLease, 6_001, 5_000))
      .rejects.toBeInstanceOf(DriveAttemptLeaseLostError);
    await expect(repository.saveSession(claim.attempt.id, savedLease, sessionFixture(1_100), 6_001))
      .rejects.toBeInstanceOf(DriveAttemptLeaseLostError);
    await expect(repository.confirmOffset(claim.attempt.id, savedLease, 1, 6_001))
      .rejects.toBeInstanceOf(DriveAttemptLeaseLostError);
    await expect(repository.markRetryable(claim.attempt.id, savedLease, 'temporary', 6_100, 6_001))
      .rejects.toBeInstanceOf(DriveAttemptLeaseLostError);
    await expect(repository.markVerified(claim.attempt.id, savedLease, verifiedObject('file-1', 'folder-1'), 6_001))
      .rejects.toBeInstanceOf(DriveAttemptLeaseLostError);
  });

  it('rejects the original owner exactly when its lease expires', async () => {
    const artifact = await repository.register(artifactFixture());
    await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const claim = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!claim) throw new Error('expected claim');

    await expect(repository.markVerified(claim.attempt.id, claim.lease, verifiedObject('file-1', 'folder-1'), 6_000))
      .rejects.toBeInstanceOf(DriveAttemptLeaseLostError);
  });

  it('keeps the in-memory adapter fenced at the exact lease-expiry boundary', async () => {
    const inMemory = new InMemoryArchiveArtifactRepository();
    const artifact = await inMemory.register(artifactFixture());
    await inMemory.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const claim = await inMemory.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!claim) throw new Error('expected claim');

    await expect(inMemory.markVerified(claim.attempt.id, claim.lease, verifiedObject('file-1', 'folder-1'), 6_000))
      .rejects.toBeInstanceOf(DriveAttemptLeaseLostError);
  });

  it('stores retry count and the retry mutation timestamp rather than its scheduled retry time', async () => {
    const artifact = await repository.register(artifactFixture());
    await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 100);
    const claim = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!claim) throw new Error('expected claim');

    await repository.markRetryable(claim.attempt.id, claim.lease, 'temporarily_unavailable', 9_000, 1_100);

    expect((await repository.listAttempts(artifact.id))[0]).toMatchObject({ retryCount: 1, updatedAtMs: 1_100 });
  });

  it('selects a due backup before a video and admits an eligible older video retry when fairness is due', async () => {
    const video = await repository.register(artifactFixture());
    const backup = await repository.register({ ...artifactFixture(), kind: 'database_backup', sourceFingerprint: 'c'.repeat(64) });
    await repository.createAttempt(video.id, 'generation-1', 'video-new', 'folder-1', 200);
    await repository.createAttempt(backup.id, 'generation-1', 'backup-1', 'folder-2', 300);

    const backupClaim = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000, preferBackups: true });
    expect(backupClaim?.attempt.remoteObjectId).toBe('backup-1');

    const retryClaim = await repository.claimNextAttempt({ owner: 'worker-b', nowMs: 1_000, leaseMs: 5_000 });
    if (!retryClaim) throw new Error('expected video claim');
    await repository.markRetryable(retryClaim.attempt.id, retryClaim.lease, 'temporary', 1_010, 1_005);
    await repository.createAttempt(video.id, 'generation-1', 'video-newer', 'folder-1', 1_006);

    const fairClaim = await repository.claimNextAttempt({ owner: 'worker-c', nowMs: 1_010, leaseMs: 5_000, forceVideoRetryBeforeMs: 1_010 });
    expect(fairClaim?.attempt.remoteObjectId).toBe('video-new');
  });

  it('orders retention candidates by provider creation time, not local attempt creation time', async () => {
    const firstArtifact = await repository.register(artifactFixture());
    const secondArtifact = await repository.register({ ...artifactFixture(), sourceFingerprint: 'c'.repeat(64), relativePath: 'motion/second.mp4' });
    await repository.createAttempt(firstArtifact.id, 'generation-1', 'file-later-provider', 'folder-1', 100);
    await repository.createAttempt(secondArtifact.id, 'generation-1', 'file-earlier-provider', 'folder-1', 200);
    const first = await repository.claimNextAttempt({ owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000 });
    if (!first) throw new Error('expected first claim');
    await repository.markVerified(first.attempt.id, first.lease, { ...verifiedObject('file-later-provider', 'folder-1'), providerCreatedAtMs: 2_000 }, 1_100);
    const second = await repository.claimNextAttempt({ owner: 'worker-b', nowMs: 1_000, leaseMs: 5_000 });
    if (!second) throw new Error('expected second claim');
    await repository.markVerified(second.attempt.id, second.lease, { ...verifiedObject('file-earlier-provider', 'folder-1'), providerCreatedAtMs: 1_000 }, 1_200);

    expect((await repository.listRetentionCandidates({ kind: 'motion_video', limit: 2 })).map((attempt) => attempt.remoteObjectId))
      .toEqual(['file-earlier-provider', 'file-later-provider']);
  });

  it('atomically records exact deletion and clears the artifact verification pointer', async () => {
    const artifact = await repository.register(artifactFixture());
    const attempt = await repository.createAttempt(
      artifact.id, 'generation-1', 'file-1', 'folder-1', 100,
    );
    const claim = await repository.claimAttempt(attempt.id, {
      owner: 'worker-a', nowMs: 1_000, leaseMs: 5_000,
    });
    await repository.markVerified(
      attempt.id, claim.lease, verifiedObject('file-1', 'folder-1'), 1_100,
    );
    const verified = await repository.loadAttempt(attempt.id);
    if (!verified) throw new Error('expected verified attempt');

    await repository.markDeleted(verified.id, verified.revision, 1_200);

    expect(await repository.loadAttempt(attempt.id)).toMatchObject({
      state: 'deleted',
      deletedAtMs: 1_200,
    });
    expect(await repository.loadArtifact(artifact.id)).toMatchObject({
      state: 'pending',
      currentVerifiedAttemptId: null,
    });
  });
});

function artifactFixture() {
  return {
    installationId: 'installation-1',
    kind: 'motion_video' as const,
    sourceIdentity: 'camera-1',
    trustedPath: '/var/lib/home-worker/motion/clip.mp4',
    relativePath: 'motion/clip.mp4',
    size: 42,
    mtimeNs: '100',
    sourceTimeMs: 100,
    sha256: 'a'.repeat(64),
    sourceFingerprint: 'b'.repeat(64),
  };
}

function verifiedObject(id: string, parentId: string) {
  return {
    objectId: id,
    name: 'clip.mp4',
    containerId: parentId,
    contentType: 'video/mp4',
    size: 42,
    sha256: 'a'.repeat(64),
    md5: 'c'.repeat(32),
    providerCreatedAtMs: 1_000,
    revisionId: 'revision-1',
    version: '1',
    ownedByInstallation: true,
    canDelete: true,
    trashed: false,
    attributes: { artifact: 'archive-1' },
    sharing: { ownerPermissionId: 'owner-1', shared: false, permissionIds: ['owner-1'] },
    webViewLink: null,
  };
}

function sessionFixture(createdAtMs: number) {
  return {
    ciphertext: 'ciphertext',
    nonce: 'nonce',
    authTag: 'auth-tag',
    keyVersion: 1,
    formatVersion: 1 as const,
    createdAtMs,
    expiresAtMs: createdAtMs + 10_000,
    confirmedOffset: 0,
  };
}

async function seedBlockedPath(
  repository: DriveFolderReservationRepositoryPort,
  generationId: string,
  dayPath: string,
  state: 'detached' | 'conflict',
  blockedLevel: 'year' | 'month' | 'day' = 'day',
): Promise<void> {
  const segments = dayPath.split('/');
  const paths = [segments[0], segments.slice(0, 2).join('/'), dayPath];
  let parentFolderId = 'motion-root';
  for (const [index, normalizedPath] of paths.entries()) {
    const id = `${generationId}-reservation-${index}`;
    const folderId = `${generationId}-folder-${index}`;
    const stored = await repository.compareAndSetCurrent({
      expected: null,
      replacement: {
        id,
        installationId: 'installation-1',
        generationId,
        normalizedPath,
        level: ['year', 'month', 'day'][index] as 'year' | 'month' | 'day',
        segmentName: segments[index],
        folderId,
        parentFolderId,
      },
      nowMs: index + 1,
    });
    if (stored.kind !== 'stored') throw new Error('expected seeded folder head');
    const verified = await repository.markVerified(
      stored.reservation.id, stored.reservation.revision, index + 10,
    );
    if (!verified) throw new Error('expected verified seeded folder head');
    if (['year', 'month', 'day'][index] === blockedLevel) {
      const blocked = await repository.markBlocked(
        verified.id, verified.revision, state, 'seeded_block', index + 20,
      );
      if (!blocked) throw new Error('expected blocked seeded folder head');
    }
    parentFolderId = folderId;
  }
}
