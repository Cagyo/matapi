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
import { DriveQuotaExceededError } from '../../../src/archive/domain/errors/drive-quota-exceeded.error';
import type { ArchiveRetentionPort } from '../../../src/archive/application/ports/archive-retention.port';
import { ArchiveWakeService } from '../../../src/archive/application/archive-wake.service';
import { ArchiveProviderGateService } from '../../../src/archive/application/archive-provider-gate.service';
import { InMemoryArchiveProviderStateRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-provider-state.repository';
import type { ArchiveArtifact } from '../../../src/archive/domain/archive-artifact.entity';
import type { DriveCredentialRepositoryPort } from '../../../src/archive/application/ports/drive-credential-repository.port';
import { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import type { ArchiveProviderState } from '../../../src/archive/application/ports/archive-provider-state-repository.port';
import type { ArchiveAdminAlertKind } from '../../../src/archive/application/ports/archive-admin-alert.port';

function claimedAttempt(overrides: Partial<ClaimedAttempt['attempt']> = {}): ClaimedAttempt {
  return {
    artifact: {
      id: 'video-artifact', kind: 'motion_video', installationId: 'installation-1', size: 4_096,
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

function activeConnection(id: string): DriveConnection {
  return DriveConnection.stage({ id, installationId: 'installation-1', nowMs: 1 }).activate({
    permissionId: `owner-${id}`,
    email: null,
    displayName: null,
    folders: { rootId: 'root-folder', motionId: 'motion-folder', backupsId: 'backup-folder' },
    nowMs: 2,
  });
}

function setup(options: {
  upload?: (
    claimed?: ClaimedAttempt,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  selectedGenerationId?: string;
  backup?: () => Promise<unknown>;
  nowMs?: number;
  connection?: DriveConnection | null;
  providerState?: ArchiveProviderState;
  queueStatus?: { queuedVideos: number; retryableVideos: number; oldestQueuedVideoAtMs: number | null; branchBlocked: boolean };
  diskUsagePercent?: number | null;
} = {}) {
  const clock = { now: vi.fn(() => new Date(options.nowMs ?? 10_000)) } satisfies ClockPort;
  const video = {
    id: 'video-artifact', kind: 'motion_video', installationId: 'installation-1',
    size: 4_096, createdAtMs: 1,
  } as ArchiveArtifact;
  const queuedArtifacts: ArchiveArtifact[] = [];
  const claimedAttempts: ClaimedAttempt[] = [];
  const admissionTimes: number[] = [];
  const settleTimes: number[] = [];
  let activeUploads = 0;
  let highestActiveUploads = 0;
  const repository = {
    claimNextAttempt: vi.fn(async (input: { kind?: string }) => {
      const index = claimedAttempts.findIndex(({ artifact }) => artifact.kind === input.kind);
      return index < 0 ? null : claimedAttempts.splice(index, 1)[0];
    }),
    listUnattemptedArtifacts: vi.fn(async (selection: { kind: string }) =>
      queuedArtifacts.filter(({ kind }) => kind === selection.kind).slice(0, 1)),
    readNextDeadline: vi.fn(async (
      _generationId: string,
      _nowMs: number,
      _providerCooldownUntilMs: number | null,
    ) => null),
    readSchedulerState: vi.fn(async () => ({
      revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null,
      lastBackupSuccessMs: null, lastUploadSuccessMs: null,
      lastReconcileSuccessMs: null, lastCleanupSuccessMs: null,
    })),
    compareAndSetSchedulerState: vi.fn(async () => true),
    markRetryable: vi.fn(async () => undefined),
    readQueueStatus: vi.fn(async () => options.queueStatus ?? ({
      queuedVideos: 0, retryableVideos: 0, oldestQueuedVideoAtMs: null, branchBlocked: false,
    })),
  } as unknown as ArchiveArtifactRepositoryPort;
  const backups = {
    execute: vi.fn(options.backup ?? (async () => ({ created: false, reason: 'not_due' }))),
  } as unknown as CreateDatabaseBackupUseCase;
  const uploads = {
    execute: vi.fn(async (
      artifactId: string,
      signal: AbortSignal,
      onGenerationSelected?: (generationId: string) => void,
    ) => {
      onGenerationSelected?.(options.selectedGenerationId ?? 'generation-1');
      const queued = queuedArtifacts.findIndex(({ id }) => id === artifactId);
      if (queued >= 0) queuedArtifacts.splice(queued, 1);
      admissionTimes.push(clock.now().getTime());
      activeUploads += 1;
      highestActiveUploads = Math.max(highestActiveUploads, activeUploads);
      try {
        return await (options.upload ?? (async () => ({ kind: 'verified' })))(
          undefined,
          signal,
        );
      } finally {
        settleTimes.push(clock.now().getTime());
        activeUploads -= 1;
      }
    }),
    executeClaimed: vi.fn(async (
      claimed: ClaimedAttempt,
      signal: AbortSignal,
      onGenerationSelected?: (generationId: string) => void,
    ) => {
      onGenerationSelected?.(
        options.selectedGenerationId ?? claimed.attempt.generationId,
      );
      admissionTimes.push(clock.now().getTime());
      activeUploads += 1;
      highestActiveUploads = Math.max(highestActiveUploads, activeUploads);
      try {
        return await (options.upload ?? (async () => ({ kind: 'verified' })))(
          claimed,
          signal,
        );
      } finally {
        settleTimes.push(clock.now().getTime());
        activeUploads -= 1;
      }
    }),
  } as unknown as UploadDriveObjectAttemptUseCase;
  const retention = {
    execute: vi.fn(async () => ({
      deletedIds: [], reclaimedBytes: 0, remainingDeficitBytes: 0,
      accountingWindowActive: false,
    })),
  } as ArchiveRetentionPort;
  const hooks = new ArchiveSchedulerHooksService();
  const wake = new ArchiveWakeService();
  const providerGate = new ArchiveProviderGateService(
    new InMemoryArchiveProviderStateRepository(),
    clock,
  );
  const credentials = {
    loadActive: vi.fn(async () => options.connection === undefined
      ? activeConnection('generation-1')
      : options.connection),
  } satisfies Pick<DriveCredentialRepositoryPort, 'loadActive'>;
  const providerState = {
    load: vi.fn(async () => options.providerState ?? ({
      revision: 0, generationId: null, operationClass: null, failureClass: null,
      failureStreak: 0, cooldownUntilMs: null, blockReason: null, updatedAtMs: 0,
    })),
  };
  const alerts = { alert: vi.fn(async (_kind: ArchiveAdminAlertKind) => undefined) };
  const localDisk = { usagePercent: vi.fn(async () => options.diskUsagePercent ?? null) };
  const Scheduler = ArchiveSchedulerService as unknown as new (
    repository: ArchiveArtifactRepositoryPort,
    backups: CreateDatabaseBackupUseCase,
    uploads: UploadDriveObjectAttemptUseCase,
    hooks: ArchiveSchedulerHooksService,
    lock: ArchiveRemoteMutationLockService,
    retention: ArchiveRetentionPort,
    clock: ClockPort,
    options: { intervalMs: number; shutdownWaitMs: number; newerVideoBatch: number },
    wake: ArchiveWakeService,
    providerGate: ArchiveProviderGateService,
    credentials: Pick<DriveCredentialRepositoryPort, 'loadActive'>,
    providerState: typeof providerState,
    alerts: typeof alerts,
    localDisk: typeof localDisk,
  ) => ArchiveSchedulerService;
  const scheduler = new Scheduler(
    repository,
    backups,
    uploads,
    hooks,
    new ArchiveRemoteMutationLockService(),
    retention,
    clock,
    { intervalMs: 60_000, shutdownWaitMs: 10, newerVideoBatch: 2 },
    wake,
    providerGate,
    credentials,
    providerState,
    alerts,
    localDisk,
  );
  return {
    repository, backups, uploads, retention, hooks, scheduler, wake, providerGate, clock,
    credentials, providerState, alerts, localDisk, video,
    seedFreshVideos(count: number) {
      queuedArtifacts.push(...Array.from({ length: count }, (_, index) => ({
        ...video, id: `video-${index + 1}`,
      })));
    },
    seedFreshBackups(count: number) {
      queuedArtifacts.push(...Array.from({ length: count }, (_, index) => ({
        ...video, id: `backup-${index + 1}`, kind: 'database_backup' as const,
      })));
    },
    seedClaimedAttempts(...attempts: ClaimedAttempt[]) { claimedAttempts.push(...attempts); },
    maxConcurrentUploads: () => highestActiveUploads,
    elapsedBetweenAdmissions: () => admissionTimes.slice(1).map((time, index) => time - settleTimes[index]),
  };
}

describe('ArchiveSchedulerService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not lose a registration between the final empty read and wait arming', async () => {
    const fixture = setup();
    vi.mocked(fixture.repository.claimNextAttempt).mockResolvedValue(null);
    vi.mocked(fixture.repository.listUnattemptedArtifacts).mockResolvedValue([]);
    fixture.repository.readNextDeadline.mockImplementationOnce(async () => {
      fixture.wake.wake();
      fixture.repository.listUnattemptedArtifacts.mockResolvedValueOnce([fixture.video]);
      return null;
    });

    fixture.scheduler.startTimers();

    await vi.waitFor(() => expect(fixture.uploads.execute).toHaveBeenCalledWith(
      fixture.video.id,
      expect.any(AbortSignal),
      expect.any(Function),
    ));
    await fixture.scheduler.shutdown();
  });

  it('admits the next item immediately after settlement with one active transfer', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const upload = vi.fn()
      .mockImplementationOnce(async () => first)
      .mockResolvedValue({ kind: 'verified' });
    const fixture = setup({ upload });
    fixture.seedFreshVideos(3);

    fixture.scheduler.startTimers();
    await vi.waitFor(() => expect(fixture.uploads.execute).toHaveBeenCalledOnce());
    expect(fixture.maxConcurrentUploads()).toBe(1);
    releaseFirst();
    await vi.waitFor(() => expect(fixture.uploads.execute).toHaveBeenCalledTimes(3));

    expect(fixture.maxConcurrentUploads()).toBe(1);
    expect(fixture.elapsedBetweenAdmissions()).toEqual([0, 0]);
    await fixture.scheduler.shutdown();
  });

  it('publishes generation-tagged video activity before an uploading row exists', async () => {
    let release!: () => void;
    const fixture = setup({ upload: () => new Promise<void>((resolve) => { release = resolve; }) });
    fixture.seedFreshVideos(1);
    const activity = fixture.scheduler as unknown as {
      readActivitySnapshot?: () => { generationId: string; artifactKind: string; startedAtMs: number } | null;
    };

    fixture.scheduler.startTimers();
    await vi.waitFor(() => expect(fixture.uploads.execute).toHaveBeenCalledOnce());
    expect(typeof activity.readActivitySnapshot).toBe('function');
    expect(activity.readActivitySnapshot?.()).toEqual({
      generationId: 'generation-1', artifactKind: 'motion_video', startedAtMs: 10_000,
    });

    release();
    await vi.waitFor(() => expect(activity.readActivitySnapshot?.()).toBeNull());
    await fixture.scheduler.shutdown();
  });

  it.each([
    ['prolonged upload cooldown', {
      nowMs: 1_000_000,
      providerState: {
        revision: 1, generationId: 'generation-1', operationClass: 'upload' as const,
        failureClass: 'rate-limit' as const, failureStreak: 1,
        cooldownUntilMs: 2_000_000, blockReason: null, updatedAtMs: 100_000,
      },
    }, 'provider-cooldown-prolonged'],
    ['capacity block', {
      providerState: {
        revision: 1, generationId: 'generation-1', operationClass: 'upload' as const,
        failureClass: 'capacity' as const, failureStreak: 1,
        cooldownUntilMs: null, blockReason: 'account_creation_limit', updatedAtMs: 9_000,
      },
    }, 'provider-capacity-blocked'],
    ['storage quota block', {
      providerState: {
        revision: 1, generationId: 'generation-1', operationClass: 'upload' as const,
        failureClass: 'quota' as const, failureStreak: 1,
        cooldownUntilMs: null, blockReason: 'quota_exhausted', updatedAtMs: 9_000,
      },
    }, 'quota-reclamation-required'],
    ['reauthorization', {
      connection: activeConnection('generation-1').requireReauthorization(9_000),
    }, 'reauthorization-required'],
    ['prolonged backlog', {
      nowMs: 86_410_000,
      queueStatus: {
        queuedVideos: 1, retryableVideos: 0, oldestQueuedVideoAtMs: 10_000, branchBlocked: false,
      },
    }, 'backlog-age-prolonged'],
    ['local disk pressure', { diskUsagePercent: 70 }, 'local-disk-pressure'],
  ] as const)('emits a production %s alert from the maintenance tick', async (
    _scenario,
    options,
    expected,
  ) => {
    const fixture = setup(options);

    await fixture.scheduler.tick();

    expect(fixture.alerts.alert).toHaveBeenCalledWith(expected, {
      generationId: 'generation-1',
    });
  });

  it('does not emit prolonged alerts one millisecond before their thresholds', async () => {
    const fixture = setup({
      nowMs: 86_409_999,
      providerState: {
        revision: 1, generationId: 'generation-1', operationClass: 'upload',
        failureClass: 'rate-limit', failureStreak: 1,
        cooldownUntilMs: 90_000_000, blockReason: null,
        updatedAtMs: 85_510_000,
      },
      queueStatus: {
        queuedVideos: 1, retryableVideos: 0, oldestQueuedVideoAtMs: 10_000, branchBlocked: false,
      },
      diskUsagePercent: 69,
    });

    await fixture.scheduler.tick();

    expect(fixture.alerts.alert).not.toHaveBeenCalledWith(
      'provider-cooldown-prolonged', expect.anything(),
    );
    expect(fixture.alerts.alert).not.toHaveBeenCalledWith(
      'backlog-age-prolonged', expect.anything(),
    );
    expect(fixture.alerts.alert).not.toHaveBeenCalledWith(
      'local-disk-pressure', expect.anything(),
    );
  });

  it('does not emit an alert for a generation replaced during maintenance projection', async () => {
    const fixture = setup({
      providerState: {
        revision: 1, generationId: 'generation-1', operationClass: 'upload',
        failureClass: 'capacity', failureStreak: 1, cooldownUntilMs: null,
        blockReason: 'account_creation_limit', updatedAtMs: 9_000,
      },
    });
    fixture.credentials.loadActive
      .mockResolvedValueOnce(activeConnection('generation-1'))
      .mockResolvedValueOnce(activeConnection('generation-2'));

    await fixture.scheduler.tick();

    expect(fixture.alerts.alert).not.toHaveBeenCalled();
  });

  it('does not map temporary provider capacity to immediate administrator action', async () => {
    const fixture = setup({
      nowMs: 1_000_000,
      providerState: {
        revision: 1, generationId: 'generation-1', operationClass: 'upload',
        failureClass: 'capacity', failureStreak: 1, cooldownUntilMs: 2_000_000,
        blockReason: null, updatedAtMs: 100_001,
      },
    });

    await fixture.scheduler.tick();

    expect(fixture.alerts.alert).not.toHaveBeenCalled();
  });

  it('maps temporary provider capacity only to prolonged cooldown at the threshold', async () => {
    const fixture = setup({
      nowMs: 1_000_000,
      providerState: {
        revision: 1, generationId: 'generation-1', operationClass: 'upload',
        failureClass: 'capacity', failureStreak: 1, cooldownUntilMs: 2_000_000,
        blockReason: null, updatedAtMs: 100_000,
      },
    });

    await fixture.scheduler.tick();

    expect(fixture.alerts.alert.mock.calls).toEqual([
      ['provider-cooldown-prolonged', { generationId: 'generation-1' }],
    ]);
  });

  it('sleeps until the earliest durable deadline without tight polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const fixture = setup();
    fixture.clock.now.mockImplementation(() => new Date(Date.now()));
    vi.mocked(fixture.repository.readNextDeadline).mockImplementation(
      async (_generationId, nowMs) => nowMs < 20_000 ? 20_000 : null,
    );
    vi.mocked(fixture.repository.claimNextAttempt).mockResolvedValue(null);
    vi.mocked(fixture.repository.listUnattemptedArtifacts).mockResolvedValue([]);

    fixture.scheduler.startTimers();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.repository.readNextDeadline).toHaveBeenCalledOnce();
    vi.mocked(fixture.repository.claimNextAttempt).mockClear();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fixture.repository.claimNextAttempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.repository.claimNextAttempt).toHaveBeenCalled();
    const claimCountAfterDeadline = fixture.repository.claimNextAttempt.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.repository.claimNextAttempt).toHaveBeenCalledTimes(claimCountAfterDeadline);
    await fixture.scheduler.shutdown();
  });

  it('does not let a stalled video transfer block backup creation or unrelated cleanup', async () => {
    const stalled = new Promise<never>(() => undefined);
    const fixture = setup({ upload: () => stalled });
    fixture.seedClaimedAttempts(claimedAttempt());
    const registration = vi.fn(async () => undefined);
    const localCleanup = vi.fn(async () => undefined);
    fixture.hooks.registerCamera({ reconcileMotion: registration, cleanupLocal: localCleanup });

    fixture.scheduler.startTimers();
    await vi.waitFor(() => expect(fixture.uploads.executeClaimed).toHaveBeenCalledOnce());
    await fixture.scheduler.tick();
    await fixture.scheduler.tick();

    expect(fixture.backups.execute).toHaveBeenCalledTimes(2);
    expect(registration).toHaveBeenCalledTimes(2);
    expect(localCleanup).toHaveBeenCalledTimes(2);
    expect(fixture.uploads.executeClaimed).toHaveBeenCalledTimes(1);
    await fixture.scheduler.shutdown();
  });

  it('reclaims the pending artifact size after quota failure before a later upload retry', async () => {
    const order: string[] = [];
    const upload = vi.fn()
      .mockImplementationOnce(async () => {
        order.push('upload:quota');
        throw new DriveQuotaExceededError();
      })
      .mockImplementationOnce(async () => {
        order.push('upload:verified');
        return { kind: 'verified' };
      });
    const fixture = setup({ upload });
    fixture.seedClaimedAttempts(
      claimedAttempt({ id: 'quota-attempt' }),
      claimedAttempt({ id: 'retry-attempt', retryCount: 1 }),
    );
    const retention = fixture.retention;
    vi.mocked(retention.execute).mockImplementation(
      async (input: { requiredBytes: number }) => {
        order.push(`reclaim:${input.requiredBytes}`);
        return {
          deletedIds: ['old-backup'],
          reclaimedBytes: input.requiredBytes,
          remainingDeficitBytes: 0,
          accountingWindowActive: true,
        };
      },
    );

    fixture.scheduler.startTimers();
    await vi.waitFor(() => expect(retention.execute).toHaveBeenCalledWith(
      { requiredBytes: 4_096 },
      expect.any(AbortSignal),
    ));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));

    expect(order).toEqual(['upload:quota', 'reclaim:4096', 'upload:verified']);
    await fixture.scheduler.shutdown();
  });

  it('does not admit another artifact while quota reclamation leaves a positive deficit', async () => {
    const upload = vi.fn(async () => { throw new DriveQuotaExceededError(); });
    const fixture = setup({ upload });
    fixture.seedClaimedAttempts(
      claimedAttempt({ id: 'quota-attempt' }),
      claimedAttempt({ id: 'must-wait-attempt' }),
    );
    vi.mocked(fixture.retention.execute).mockResolvedValue({
      deletedIds: ['old-backup'], reclaimedBytes: 3_000,
      remainingDeficitBytes: 1_096, accountingWindowActive: true,
    });

    fixture.scheduler.startTimers();
    await vi.waitFor(() => expect(fixture.retention.execute).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(upload).toHaveBeenCalledOnce();
    await expect(fixture.providerGate.inspect('generation-1', 'upload')).resolves.toEqual({
      kind: 'blocked', reason: 'quota_exhausted',
    });
    await fixture.scheduler.shutdown();
  });

  it('attributes quota settlement to the generation selected during upload admission', async () => {
    const fixture = setup({
      selectedGenerationId: 'generation-2',
      upload: async () => {
        throw new DriveQuotaExceededError();
      },
    });
    fixture.seedFreshVideos(1);
    vi.mocked(fixture.retention.execute).mockResolvedValue({
      deletedIds: [], reclaimedBytes: 0,
      remainingDeficitBytes: 4_096, accountingWindowActive: true,
    });
    vi.mocked(fixture.credentials.loadActive)
      .mockResolvedValueOnce(activeConnection('generation-1'))
      .mockResolvedValue(activeConnection('generation-2'));
    fixture.scheduler.startTimers();
    await vi.waitFor(() => expect(fixture.retention.execute).toHaveBeenCalledOnce());

    await expect(fixture.providerGate.inspect('generation-2', 'upload'))
      .resolves.toEqual({ kind: 'blocked', reason: 'quota_exhausted' });
    await expect(fixture.providerGate.inspect('generation-1', 'upload'))
      .resolves.toEqual({ kind: 'allowed' });
    await fixture.scheduler.shutdown();
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
    fixture.seedFreshVideos(2);
    let retryClaimed = false;
    vi.mocked(fixture.repository.claimNextAttempt)
      .mockImplementation(async (input) => {
        if (input.kind !== 'motion_video' || !input.retryOnly || retryClaimed) return null;
        retryClaimed = true;
        return claimedAttempt({ id: 'video-retry', retryCount: 2 });
      });

    fixture.scheduler.startTimers();
    await vi.waitFor(() => expect(fixture.uploads.executeClaimed).toHaveBeenCalledOnce());

    expect(fixture.uploads.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fixture.repository.claimNextAttempt).mock.calls).toContainEqual([
      expect.objectContaining({
        generationId: 'generation-1', kind: 'motion_video', retryOnly: true,
        forceVideoRetryBeforeMs: 10_000,
      }),
    ]);
    await fixture.scheduler.shutdown();
  });

  it('starts the first upload for a newly registered artifact without holding a database transaction', async () => {
    const fixture = setup();
    fixture.seedFreshBackups(1);
    vi.mocked(fixture.repository.claimNextAttempt).mockResolvedValue(null);

    fixture.scheduler.startTimers();
    await vi.waitFor(() => expect(fixture.uploads.execute).toHaveBeenCalledOnce());

    expect(fixture.repository.listUnattemptedArtifacts).toHaveBeenCalledWith({
      kind: 'database_backup', generationId: 'generation-1', nowMs: 10_000, limit: 1,
    });
    expect(fixture.uploads.execute).toHaveBeenCalledWith(
      'backup-1',
      expect.any(AbortSignal),
      expect.any(Function),
    );
    await fixture.scheduler.shutdown();
  });

  it('does not let an older blocked artifact starve a later artifact eligible for the active generation', async () => {
    const fixture = setup();
    const blocked = { ...fixture.video, id: 'blocked-oldest', createdAtMs: 1 };
    const eligible = { ...fixture.video, id: 'eligible-later', createdAtMs: 2 };
    let videoSelectionCount = 0;
    vi.mocked(fixture.repository.claimNextAttempt).mockResolvedValue(null);
    vi.mocked(fixture.repository.listUnattemptedArtifacts).mockImplementation(async (selection) => {
      if (selection.kind === 'database_backup') return [];
      videoSelectionCount += 1;
      if (videoSelectionCount > 1) return [];
      return selection.generationId === 'generation-1' && selection.nowMs === 10_000
        ? [eligible]
        : [blocked];
    });

    fixture.scheduler.startTimers();
    await vi.waitFor(() => expect(fixture.uploads.execute).toHaveBeenCalledOnce());

    expect(fixture.uploads.execute).toHaveBeenCalledWith(
      'eligible-later',
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(fixture.uploads.execute).not.toHaveBeenCalledWith(
      'blocked-oldest',
      expect.any(AbortSignal),
      expect.any(Function),
    );
    await fixture.scheduler.shutdown();
  });

  it('aborts the active upload without abandoning durable recovery state', async () => {
    let activeSignal: AbortSignal | undefined;
    const repository = { markAbandoned: vi.fn() };
    const fixture = setup({ upload: async (_claimed?: unknown, signal?: AbortSignal) => {
      activeSignal = signal;
      await new Promise<void>(() => undefined);
    } });
    fixture.seedClaimedAttempts(claimedAttempt());

    fixture.scheduler.startTimers();
    await vi.waitFor(() => expect(activeSignal).toBeDefined());
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

    fixture.scheduler.startTimers();
    await vi.waitFor(() => {
      expect(fixture.repository.claimNextAttempt).toHaveBeenCalledOnce();
    });
    const shutdown = fixture.scheduler.shutdown();
    resolveClaim(claimedAttempt());
    await shutdown;

    expect(fixture.uploads.executeClaimed).not.toHaveBeenCalled();
    expect(fixture.repository.markRetryable).toHaveBeenCalledWith(
      'video-attempt',
      expect.objectContaining({ owner: 'scheduler', revision: 1 }),
      'cancelled',
      10_000,
      10_000,
    );
  });

  it('recovers immediately from a transient claim failure when registration wakes a stalled pump', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    vi.mocked(fixture.repository.claimNextAttempt)
      .mockRejectedValueOnce(new Error('claim failed'))
      .mockResolvedValue(null);
    const logger = (fixture.scheduler as unknown as {
      logger: { error: (message: string) => void };
    }).logger;
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    fixture.scheduler.startTimers();
    await vi.advanceTimersByTimeAsync(0);
    fixture.seedFreshVideos(1);
    fixture.wake.wake();
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toHaveBeenCalledWith('Archive scheduler pump failed: claim failed');
    expect(fixture.uploads.execute).toHaveBeenCalledOnce();
    await fixture.scheduler.shutdown();
  });
});
