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
