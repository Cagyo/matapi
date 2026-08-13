import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveArtifact, type RegisterArchiveArtifact } from '../../../src/archive/domain/archive-artifact.entity';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';
import { InMemoryDriveFolderReservationRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-folder-reservation.repository';

describe('archive artifact admission', () => {
  let folderReservations: InMemoryDriveFolderReservationRepository;
  let repository: InMemoryArchiveArtifactRepository;

  beforeEach(() => {
    folderReservations = new InMemoryDriveFolderReservationRepository();
    repository = new InMemoryArchiveArtifactRepository(folderReservations);
  });

  afterEach(() => vi.restoreAllMocks());

  it('records the first validated day path and rejects a different later path', async () => {
    const artifact = await repository.register(artifactInput('immutable', 'b'));
    const admitted = await repository.recordMotionAdmissionPath(
      artifact.id, artifact.admission.revision, '2026/08/13', 100,
    );

    expect(admitted.admission).toEqual({
      state: 'ready', motionDayPath: '2026/08/13', nextAttemptMs: 0,
      errorCode: null, revision: 1,
    });
    await expect(repository.recordMotionAdmissionPath(
      artifact.id, admitted.admission.revision, '2026/08/14', 101,
    )).rejects.toThrow('immutable');
  });

  it('fences stale writers and permits retryable-to-ready but not terminal transitions', async () => {
    const artifact = await repository.register(artifactInput('fenced', 'c'));
    const retryable = await repository.markAdmissionRetryable(
      artifact.id, 0, 'provider_cooldown', 500, 50,
    );

    expect(retryable.admission).toEqual({
      state: 'retryable', motionDayPath: null, nextAttemptMs: 500,
      errorCode: 'provider_cooldown', revision: 1,
    });
    await expect(repository.markAdmissionTerminal(
      artifact.id, 0, 'stale_writer', 51,
    )).rejects.toThrow('changed');

    const ready = await repository.recordMotionAdmissionPath(
      artifact.id, 1, '2026/08/13', 52,
    );
    expect(ready.admission).toEqual({
      state: 'ready', motionDayPath: '2026/08/13', nextAttemptMs: 0,
      errorCode: null, revision: 2,
    });

    const terminal = await repository.markAdmissionTerminal(
      artifact.id, 2, 'invalid_motion_path', 53,
    );
    expect(terminal.admission).toMatchObject({
      state: 'terminal', errorCode: 'invalid_motion_path', revision: 3,
    });
    await expect(repository.markAdmissionRetryable(
      artifact.id, 3, 'temporary', 600, 54,
    )).rejects.toThrow(/terminal/iu);
  });

  it('rejects admission transitions for database backups without changing their state', async () => {
    const backup = await repository.register({
      ...artifactInput('backup-admission', '0'),
      kind: 'database_backup',
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

  it('rejects a restored terminal admission with a future deadline', async () => {
    const artifact = await repository.register(artifactInput('terminal-restore', 'a'));

    expect(() => ArchiveArtifact.restore({
      ...artifact,
      admission: {
        state: 'terminal',
        motionDayPath: null,
        nextAttemptMs: 1,
        errorCode: 'invalid_motion_path',
        revision: 1,
      },
    })).toThrow(/terminal archive admission/iu);
  });

  it('skips a blocked oldest branch and selects a later healthy artifact', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2);
    const blocked = await repository.register(artifactInput('blocked', 'd', '2026/08/13'));
    await repository.recordMotionAdmissionPath(blocked.id, 0, '2026/08/13', 10);
    const healthy = await repository.register(artifactInput('healthy', 'e', '2026/08/14'));
    await repository.recordMotionAdmissionPath(healthy.id, 0, '2026/08/14', 11);
    await folderReservations.seedBlockedPath('generation-1', '2026/08/13', 'detached');

    expect(await repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId: 'generation-1', nowMs: 100, limit: 1,
    })).toMatchObject([{ id: healthy.id }]);
  });

  it('skips an artifact when its current year ancestor is blocked', async () => {
    const blocked = await repository.register(artifactInput('blocked-year', 'd', '2026/08/13'));
    await repository.recordMotionAdmissionPath(blocked.id, 0, '2026/08/13', 10);
    const healthy = await repository.register(artifactInput('healthy-year', 'e', '2027/08/13'));
    await repository.recordMotionAdmissionPath(healthy.id, 0, '2027/08/13', 11);
    await folderReservations.seedBlockedPath(
      'generation-1', '2026/08/13', 'conflict', 'year',
    );

    expect(await repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId: 'generation-1', nowMs: 100, limit: 5,
    })).toMatchObject([{ id: healthy.id }]);
  });

  it('blocks every known path prefix without treating persisted wildcard characters as patterns', async () => {
    const blocked = await repository.register(artifactInput('ancestor', '1', '2026/08/15'));
    await repository.recordMotionAdmissionPath(blocked.id, 0, '2026/08/15', 10);
    await folderReservations.seedBlockedPath('generation-1', '2026/08/15', 'conflict');
    const wildcard = await repository.register(artifactInput('wildcard', '2', '2026/%_/15'));
    await repository.recordMotionAdmissionPath(wildcard.id, 0, '2026/%_/15', 11);

    expect(await repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId: 'generation-1', nowMs: 100, limit: 5,
    })).toMatchObject([{ id: wildcard.id }]);
  });

  it('keeps null paths eligible and orders by creation time then id before limiting', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const second = await repository.register(artifactInput('second', '3'));
    const first = await repository.register(artifactInput('first', '4'));
    const expected = [second, first].sort((left, right) => left.id.localeCompare(right.id))[0];

    expect(await repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId: 'generation-1', nowMs: 100, limit: 1,
    })).toMatchObject([{ id: expected.id, admission: { motionDayPath: null } }]);
  });

  it('filters terminal and not-yet-due admissions and projects all durable deadlines', async () => {
    const terminal = await repository.register(artifactInput('terminal', '5'));
    const retryable = await repository.register(artifactInput('retryable', '6'));
    const attempted = await repository.register(artifactInput('attempted', '7'));
    await repository.markAdmissionTerminal(terminal.id, 0, 'invalid_motion_path', 50);
    await repository.markAdmissionRetryable(retryable.id, 0, 'provider_cooldown', 500, 50);
    const attempt = await repository.createAttempt(
      attempted.id, 'generation-1', 'file-1', 'folder-1', 10,
    );
    const claim = await repository.claimAttempt(attempt.id, {
      owner: 'worker', nowMs: 20, leaseMs: 10,
    });
    await repository.markRetryable(
      attempt.id, claim.lease, 'temporary', 350, 21,
    );

    expect(await repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId: 'generation-1', nowMs: 100, limit: 10,
    })).toEqual([]);
    expect(await repository.readNextDeadline('generation-1', 100, 400)).toBe(350);
    expect(await repository.readNextDeadline('other-generation', 100, null)).toBe(500);
    expect(await repository.readNextDeadline('other-generation', 100, 400)).toBe(400);
  });

  it('reports aggregate non-terminal video queue state and blocked branches', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(40);
    const blocked = await repository.register(artifactInput('blocked-status', '8', '2026/08/16'));
    await repository.recordMotionAdmissionPath(blocked.id, 0, '2026/08/16', 50);
    const retryable = await repository.register(artifactInput('retry-status', '9'));
    await repository.markAdmissionRetryable(retryable.id, 0, 'temporary', 500, 51);
    const terminal = await repository.register(artifactInput('terminal-status', 'a'));
    await repository.markAdmissionTerminal(terminal.id, 0, 'invalid', 52);
    await repository.register({
      ...artifactInput('backup', 'f'), kind: 'database_backup',
    });
    await folderReservations.seedBlockedPath('generation-1', '2026/08/16', 'detached');

    expect(await repository.readQueueStatus('generation-1')).toEqual({
      queuedVideos: 2,
      retryableVideos: 1,
      oldestQueuedVideoAtMs: 10,
      branchBlocked: true,
    });
  });
});

function artifactInput(
  label: string,
  fingerprintCharacter: string,
  dayPath = '2026/08/14',
): RegisterArchiveArtifact {
  return {
    installationId: 'installation-1',
    kind: 'motion_video',
    sourceIdentity: `motion:${label}`,
    trustedPath: `/motion/${label}.mp4`,
    relativePath: `${dayPath}/120000-${label}.mp4`,
    size: 42,
    mtimeNs: '100',
    sourceTimeMs: 100,
    sha256: 'a'.repeat(64),
    sourceFingerprint: fingerprintCharacter.repeat(64),
  };
}
