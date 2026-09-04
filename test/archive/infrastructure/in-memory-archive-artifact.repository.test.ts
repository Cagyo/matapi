import { describe, expect, it } from 'vitest';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';

describe('InMemoryArchiveArtifactRepository session clearing', () => {
  it('persists the registration-success clock behind scheduler CAS fencing', async () => {
    const repository = new InMemoryArchiveArtifactRepository();
    const initial = await repository.readSchedulerState();

    expect(await repository.compareAndSetSchedulerState(initial.revision, {
      lastArtifactRegistrationSuccessMs: 2_000,
    })).toBe(true);
    expect(await repository.compareAndSetSchedulerState(initial.revision, {
      lastArtifactRegistrationSuccessMs: 3_000,
    })).toBe(false);
    expect(await repository.readSchedulerState()).toMatchObject({
      revision: initial.revision + 1,
      lastArtifactRegistrationSuccessMs: 2_000,
    });
  });

  it('clears all encrypted session fields only through the current unexpired lease', async () => {
    const repository = new InMemoryArchiveArtifactRepository();
    const artifact = await repository.register(artifactFixture());
    const attempt = await repository.createAttempt(artifact.id, 'generation-1', 'file-1', 'folder-1', 10);
    const claimed = await repository.claimAttempt(attempt.id, { owner: 'worker', nowMs: 20, leaseMs: 100 });
    const saved = await repository.saveSession(attempt.id, claimed.lease, session(), 21);

    await expect(repository.clearSession(attempt.id, { ...saved, revision: saved.revision - 1 }, 22))
      .rejects.toThrow('lease');
    expect((await repository.loadAttempt(attempt.id))?.session).not.toBeNull();

    const cleared = await repository.clearSession(attempt.id, saved, 22);
    expect(cleared).toMatchObject({ owner: 'worker', revision: saved.revision + 1 });
    expect((await repository.loadAttempt(attempt.id))?.session).toBeNull();
  });

  it('releases process leases without a clock while preserving resumable upload state', async () => {
    const repository = new InMemoryArchiveArtifactRepository();
    const artifact = await repository.register(artifactFixture());
    const attempt = await repository.createAttempt(artifact.id, 'generation-1', 'file-restart', 'folder-1', 10);
    const claimed = await repository.claimAttempt(attempt.id, { owner: 'worker', nowMs: 20, leaseMs: 100 });
    await repository.saveSession(attempt.id, claimed.lease, session(), 21);

    expect(await repository.releaseProcessLeasesAfterRestart()).toBe(1);
    expect(await repository.loadAttempt(attempt.id)).toMatchObject({
      state: 'retryable', nextAttemptMs: 0, retryCount: 1, session: session(),
    });
  });

  it('does not claim a due attempt owned by a retired generation', async () => {
    const repository = new InMemoryArchiveArtifactRepository();
    const retired = await repository.register(artifactFixture());
    const active = await repository.register({
      ...artifactFixture(),
      sourceIdentity: 'motion:active-generation',
      sourceFingerprint: 'c'.repeat(64),
    });
    await repository.createAttempt(retired.id, 'generation-retired', 'file-retired', 'folder-1', 10);
    await repository.createAttempt(active.id, 'generation-active', 'file-active', 'folder-1', 20);

    await expect(repository.claimNextAttempt({
      generationId: 'generation-active', owner: 'worker', nowMs: 100, leaseMs: 100,
    })).resolves.toMatchObject({ attempt: { remoteObjectId: 'file-active' } });
  });

  it('reports a due pre-attempt artifact as the next eligible transfer size', async () => {
    const repository = new InMemoryArchiveArtifactRepository();
    const artifact = await repository.register({
      ...artifactFixture(),
      size: 8_192,
    });
    const admitted = await repository.recordMotionAdmissionPath(
      artifact.id,
      artifact.admission.revision,
      '2026/08/13',
      10,
    );
    await repository.markAdmissionRetryable(
      artifact.id,
      admitted.admission.revision,
      'folder_resolution_failed',
      50,
      11,
    );

    await expect(repository.readNextEligibleTransferSize('generation-1', 49))
      .resolves.toBeNull();
    await expect(repository.readNextEligibleTransferSize('generation-1', 50))
      .resolves.toBe(8_192);
  });

  it('reports the backup-first transfer size before a smaller due video', async () => {
    const repository = new InMemoryArchiveArtifactRepository();
    const video = await repository.register(artifactFixture());
    await repository.createAttempt(
      video.id,
      'generation-1',
      'video-file',
      'motion-folder',
      10,
    );
    await repository.register({
      ...artifactFixture(),
      kind: 'database_backup',
      sourceIdentity: 'backup:priority',
      sourceFingerprint: 'c'.repeat(64),
      size: 8_192,
    });

    await expect(repository.readNextEligibleTransferSize('generation-1', 100))
      .resolves.toBe(8_192);
  });

  it('mirrors fresh-video fairness when selecting the next transfer size', async () => {
    const repository = new InMemoryArchiveArtifactRepository();
    const retryArtifact = await repository.register({
      ...artifactFixture(), size: 9_000,
    });
    const retry = await repository.createAttempt(
      retryArtifact.id, 'generation-1', 'retry-file', 'motion-folder', 10,
    );
    const claimed = await repository.claimAttempt(retry.id, {
      generationId: 'generation-1', owner: 'worker', nowMs: 20, leaseMs: 100,
    });
    await repository.markRetryable(retry.id, claimed.lease, 'temporary', 30, 21);
    await repository.register({
      ...artifactFixture(),
      sourceIdentity: 'motion:fresh-priority',
      sourceFingerprint: 'd'.repeat(64),
      size: 1_000,
    });

    await expect(repository.readNextEligibleTransferSize('generation-1', 100))
      .resolves.toBe(1_000);
    await expect(repository.readNextEligibleTransferSize('generation-1', 100, 100))
      .resolves.toBe(9_000);
  });
});

function artifactFixture() {
  return {
    installationId: 'installation-1', kind: 'motion_video' as const,
    sourceIdentity: 'motion:session-clear', trustedPath: '/motion/session-clear.mp4',
    relativePath: '2026/08/13/session-clear.mp4', size: 42, mtimeNs: '1', sourceTimeMs: 1,
    sha256: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64),
  };
}

function session() {
  return {
    ciphertext: 'ciphertext', nonce: 'nonce', authTag: 'tag', keyVersion: 1,
    formatVersion: 1 as const, createdAtMs: 20, expiresAtMs: 100, confirmedOffset: 17,
  };
}
