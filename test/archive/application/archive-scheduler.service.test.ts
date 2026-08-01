import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ArchiveArtifactRepositoryPort,
  ClaimedAttempt,
} from '../../../src/archive/application/ports/archive-artifact-repository.port';
import {
  ArchiveSchedulerHooksService,
  ArchiveSchedulerService,
} from '../../../src/archive/application/archive-scheduler.service';
import { ArchiveRemoteMutationLockService } from '../../../src/archive/application/archive-remote-mutation-lock.service';
import type { CreateDatabaseBackupUseCase } from '../../../src/archive/application/use-cases/create-database-backup.use-case';
import type { UploadDriveObjectAttemptUseCase } from '../../../src/archive/application/use-cases/upload-drive-object-attempt.use-case';
import type { ClockPort } from '../../../src/events/domain/ports/clock.port';

function claimedAttempt(overrides: Partial<ClaimedAttempt['attempt']> = {}): ClaimedAttempt {
  return {
    artifact: {
      id: 'video-artifact', kind: 'motion_video', installationId: 'installation-1',
    } as ClaimedAttempt['artifact'],
    attempt: {
      id: 'video-attempt', artifactId: 'video-artifact', generationId: 'generation-1',
      remoteObjectId: 'file-1', containerId: 'motion-folder', state: 'uploading',
      createdAtMs: 1, updatedAtMs: 1, uploadedAtMs: null, verifiedAtMs: null,
      deletedAtMs: null, revision: 1, nextAttemptMs: 1, retryCount: 0,
      errorCode: null, detachedReason: null, missingReason: null, session: null,
      verifiedObject: null, ...overrides,
    },
    lease: { owner: 'scheduler', revision: 1, expiresAtMs: 60_000 },
  };
}

function setup(options: { upload?: () => Promise<unknown>; backup?: () => Promise<unknown> } = {}) {
  const repository = {
    claimNextAttempt: vi.fn(async (input: { kind?: string }) =>
      input.kind === 'database_backup' ? null : claimedAttempt()),
    listUnattemptedArtifacts: vi.fn(async () => []),
    readSchedulerState: vi.fn(async () => ({
      revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null,
      lastBackupSuccessMs: null, lastUploadSuccessMs: null,
      lastReconcileSuccessMs: null, lastCleanupSuccessMs: null,
    })),
    compareAndSetSchedulerState: vi.fn(async () => true),
    markRetryable: vi.fn(async () => undefined),
  } as unknown as ArchiveArtifactRepositoryPort;
  const backups = {
    execute: vi.fn(options.backup ?? (async () => ({ created: false, reason: 'not_due' }))),
  } as unknown as CreateDatabaseBackupUseCase;
  const uploads = {
    execute: vi.fn(async () => ({ kind: 'verified' })),
    executeClaimed: vi.fn(options.upload ?? (async () => ({ kind: 'verified' }))),
  } as unknown as UploadDriveObjectAttemptUseCase;
  const hooks = new ArchiveSchedulerHooksService();
  const clock: ClockPort = { now: () => new Date(10_000) };
  const scheduler = new ArchiveSchedulerService(
    repository,
    backups,
    uploads,
    hooks,
    new ArchiveRemoteMutationLockService(),
    clock,
    { intervalMs: 60_000, shutdownWaitMs: 10, newerVideoBatch: 2 },
  );
  return { repository, backups, uploads, hooks, scheduler };
}

describe('ArchiveSchedulerService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not let a stalled video transfer block backup creation or unrelated cleanup', async () => {
    const stalled = new Promise<never>(() => undefined);
    const fixture = setup({ upload: () => stalled });
    const registration = vi.fn(async () => undefined);
    const localCleanup = vi.fn(async () => undefined);
    fixture.hooks.registerCamera({ reconcileMotion: registration, cleanupLocal: localCleanup });

    await fixture.scheduler.tick();
    await fixture.scheduler.tick();

    expect(fixture.backups.execute).toHaveBeenCalledTimes(2);
    expect(registration).toHaveBeenCalledTimes(2);
    expect(localCleanup).toHaveBeenCalledTimes(2);
    expect(fixture.uploads.executeClaimed).toHaveBeenCalledTimes(1);
  });

  it('does not overlap scheduler ticks', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fixture = setup({ backup: () => blocked });

    const first = fixture.scheduler.tick();
    const second = fixture.scheduler.tick();
    await second;
    expect(fixture.backups.execute).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('requests backup priority and admits a due video retry after a bounded fresh-video batch', async () => {
    const fixture = setup();
    const fresh = {
      id: 'fresh-artifact', kind: 'motion_video', installationId: 'installation-1',
    } as ClaimedAttempt['artifact'];
    vi.mocked(fixture.repository.listUnattemptedArtifacts)
      .mockImplementation(async (selection) =>
        selection.kind === 'motion_video' && vi.mocked(fixture.uploads.execute).mock.calls.length < 2
          ? [fresh]
          : []);
    vi.mocked(fixture.repository.claimNextAttempt)
      .mockImplementation(async (input) => input.kind === 'motion_video' && input.retryOnly
        ? claimedAttempt({ id: 'video-retry', retryCount: 2 })
        : null);

    await fixture.scheduler.tick();
    await fixture.scheduler.tick();
    await fixture.scheduler.tick();

    expect(fixture.uploads.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fixture.repository.claimNextAttempt).mock.calls).toContainEqual([
      expect.objectContaining({
        kind: 'motion_video', retryOnly: true, forceVideoRetryBeforeMs: 10_000,
      }),
    ]);
  });

  it('starts the first upload for a newly registered artifact without holding a database transaction', async () => {
    const fixture = setup();
    const backup = {
      id: 'backup-artifact', kind: 'database_backup', installationId: 'installation-1',
    } as ClaimedAttempt['artifact'];
    vi.mocked(fixture.repository.claimNextAttempt).mockResolvedValue(null);
    vi.mocked(fixture.repository.listUnattemptedArtifacts)
      .mockImplementation(async (selection) => selection.kind === 'database_backup' ? [backup] : []);

    await fixture.scheduler.tick();

    expect(fixture.repository.listUnattemptedArtifacts).toHaveBeenCalledWith({
      kind: 'database_backup', limit: 1,
    });
    expect(fixture.uploads.execute).toHaveBeenCalledWith('backup-artifact', expect.any(AbortSignal));
  });

  it('aborts the active upload without abandoning durable recovery state', async () => {
    let activeSignal: AbortSignal | undefined;
    const repository = { markAbandoned: vi.fn() };
    const fixture = setup({ upload: async (_claimed?: unknown, signal?: AbortSignal) => {
      activeSignal = signal;
      await new Promise<void>(() => undefined);
    } });

    await fixture.scheduler.tick();
    await fixture.scheduler.shutdown();

    expect(activeSignal?.aborted).toBe(true);
    expect(repository.markAbandoned).not.toHaveBeenCalled();
  });

  it('awaits an in-progress maintenance tick after aborting its signal', async () => {
    const fixture = setup();
    let started!: () => void;
    const maintenanceStarted = new Promise<void>((resolve) => { started = resolve; });
    let settled = false;
    fixture.hooks.registerCamera({
      reconcileMotion: async (signal) => {
        started();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            settled = true;
            resolve();
          }, { once: true });
        });
      },
      cleanupLocal: async () => undefined,
    });

    const tick = fixture.scheduler.tick();
    await maintenanceStarted;
    await fixture.scheduler.shutdown();

    expect(settled).toBe(true);
    await expect(tick).resolves.toBeUndefined();
  });

  it('releases a claim acquired after shutdown cancellation as retryable', async () => {
    const fixture = setup();
    let resolveClaim!: (claimed: ClaimedAttempt) => void;
    const delayedClaim = new Promise<ClaimedAttempt>((resolve) => { resolveClaim = resolve; });
    vi.mocked(fixture.repository.claimNextAttempt).mockImplementation(async (input) => {
      if (input.kind === 'database_backup') return delayedClaim;
      return null;
    });

    const tick = fixture.scheduler.tick();
    await vi.waitFor(() => {
      expect(fixture.repository.claimNextAttempt).toHaveBeenCalledOnce();
    });
    const shutdown = fixture.scheduler.shutdown();
    resolveClaim(claimedAttempt());
    await shutdown;
    await tick;

    expect(fixture.uploads.executeClaimed).not.toHaveBeenCalled();
    expect(fixture.repository.markRetryable).toHaveBeenCalledWith(
      'video-attempt',
      expect.objectContaining({ owner: 'scheduler', revision: 1 }),
      'cancelled',
      10_000,
      10_000,
    );
  });

  it('catches and logs timer-dispatched tick failures', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    vi.mocked(fixture.repository.claimNextAttempt).mockRejectedValue(new Error('claim failed'));
    const logger = (fixture.scheduler as unknown as {
      logger: { error: (message: string) => void };
    }).logger;
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    fixture.scheduler.startTimers();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(log).toHaveBeenCalledWith('Archive scheduler tick failed: claim failed');
    await fixture.scheduler.shutdown();
  });
});
