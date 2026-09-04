import { describe, expect, it, vi } from 'vitest';
import {
  deriveArchiveDrainState,
  ReportDriveStatusUseCase,
} from '../../../src/archive/application/use-cases/report-drive-status.use-case';

describe('ReportDriveStatusUseCase', () => {
  it.each([
    ['reauthorization_required', 'reauthorization-required', {
      reauthorizationRequired: true, clockBlocked: true, providerBlock: 'policy-blocked' as const,
      hasActiveTransfer: true, queuedVideos: 1, branchBlocked: true, coolingDown: true,
    }],
    ['clock_blocked', 'clock-blocked', {
      reauthorizationRequired: false, clockBlocked: true, providerBlock: 'policy-blocked' as const,
      hasActiveTransfer: true, queuedVideos: 1, branchBlocked: true, coolingDown: true,
    }],
    ['policy_blocked', 'policy-blocked', {
      reauthorizationRequired: false, clockBlocked: false, providerBlock: 'policy-blocked' as const,
      hasActiveTransfer: true, queuedVideos: 1, branchBlocked: true, coolingDown: true,
    }],
    ['capacity_blocked', 'capacity-blocked', {
      reauthorizationRequired: false, clockBlocked: false, providerBlock: 'capacity-blocked' as const,
      hasActiveTransfer: true, queuedVideos: 1, branchBlocked: true, coolingDown: true,
    }],
    ['quota_blocked', 'quota-blocked', {
      reauthorizationRequired: false, clockBlocked: false, providerBlock: 'quota-blocked' as const,
      hasActiveTransfer: true, queuedVideos: 1, branchBlocked: true, coolingDown: true,
    }],
    ['active', 'active', {
      reauthorizationRequired: false, clockBlocked: false, providerBlock: null,
      hasActiveTransfer: true, queuedVideos: 1, branchBlocked: true, coolingDown: true,
    }],
    ['branch_blocked', 'branch-blocked', {
      reauthorizationRequired: false, clockBlocked: false, providerBlock: null,
      hasActiveTransfer: false, queuedVideos: 1, branchBlocked: true, coolingDown: true,
    }],
    ['cooling_down', 'cooling-down', {
      reauthorizationRequired: false, clockBlocked: false, providerBlock: null,
      hasActiveTransfer: false, queuedVideos: 1, branchBlocked: false, coolingDown: true,
    }],
    ['idle', 'idle', {
      reauthorizationRequired: false, clockBlocked: false, providerBlock: null,
      hasActiveTransfer: false, queuedVideos: 0, branchBlocked: false, coolingDown: false,
    }],
  ] as const)('applies drain-state precedence for %s', (_scenario, expected, input) => {
    expect(deriveArchiveDrainState(input)).toBe(expected);
  });

  it('reports clock-blocked before provider, queue, or active transfer state', async () => {
    const readQuota = vi.fn(async () => ({
      limitBytes: 100,
      usageBytes: 70,
      usageInDriveBytes: 60,
      usageInDriveTrashBytes: 10,
    }));
    const artifacts = aggregateArtifacts();
    artifacts.readSchedulerState = async () => ({
      ...schedulerState(),
      clockHealth: 'clock-blocked' as const,
    });
    artifacts.readQueueStatus = async () => ({
      queuedVideos: 1, retryableVideos: 1, oldestQueuedVideoAtMs: 9_000,
      branchBlocked: true,
    });
    const useCase = statusUseCase({
      artifacts,
      provider: providerState({ blockReason: 'quota_exhausted' }),
      activity: {
        readActivitySnapshot: () => ({
          generationId: 'generation-1', artifactKind: 'motion_video', startedAtMs: 9_000,
        }),
      },
      account: { readQuota },
    });

    await expect(useCase.execute()).resolves.toMatchObject({
      drainState: 'clock-blocked',
      requiredAction: 'fix-system-clock',
      recovery: null,
      quota: null,
    });
    expect(readQuota).not.toHaveBeenCalled();
  });

  it.each([
    ['branch-blocked', 'restore-date-folder', null],
    ['quota-blocked', 'free-drive-space', 'quota_exhausted'],
    ['capacity-blocked', 'fix-capacity-then-retry', 'account_creation_limit'],
    ['policy-blocked', 'fix-policy-then-retry', 'policy_blocked'],
    ['clock-blocked', 'fix-system-clock', null],
    ['reauthorization-required', 'reauthorize', 'reauthorization_required'],
    ['idle', null, null],
  ] as const)('maps %s to one exact action', async (state, requiredAction, blockReason) => {
    const artifacts = aggregateArtifacts();
    if (state === 'branch-blocked') {
      artifacts.readQueueStatus = async () => ({
        queuedVideos: 1, retryableVideos: 1, oldestQueuedVideoAtMs: 9_000,
        branchBlocked: true,
      });
    }
    if (state === 'clock-blocked') {
      artifacts.readSchedulerState = async () => ({
        ...schedulerState(),
        clockHealth: 'clock-blocked' as const,
      });
    }

    const report = await statusUseCase({
      artifacts,
      provider: providerState({ blockReason }),
    }).execute();

    expect(report).toMatchObject({ drainState: state, requiredAction });
  });

  it('projects the current provider revision only through a retryable recovery fence', async () => {
    const report = await statusUseCase({
      provider: providerState({ revision: 17, blockReason: 'policy_blocked' }),
    }).execute();

    expect(report).toMatchObject({
      drainState: 'policy-blocked',
      requiredAction: 'fix-policy-then-retry',
      recovery: { generationId: 'generation-1', providerRevision: 17, retryable: true },
    });
  });

  it('marks a current branch fence retryable', async () => {
    const artifacts = aggregateArtifacts();
    artifacts.readQueueStatus = async () => ({
      queuedVideos: 1, retryableVideos: 1, oldestQueuedVideoAtMs: 9_000,
      branchBlocked: true,
    });

    const report = await statusUseCase({
      artifacts,
      provider: providerState({ revision: 23, operationClass: null }),
    }).execute();

    expect(report.recovery).toEqual({
      generationId: 'generation-1', providerRevision: 23, retryable: true,
    });
  });

  it('withholds a manual fence while a provider cooldown owns a branch block', async () => {
    const artifacts = aggregateArtifacts();
    artifacts.readQueueStatus = async () => ({
      queuedVideos: 1, retryableVideos: 1, oldestQueuedVideoAtMs: 9_000,
      branchBlocked: true,
    });

    const report = await statusUseCase({
      artifacts,
      provider: providerState({
        revision: 29,
        failureClass: 'rate-limit',
        failureStreak: 1,
        cooldownUntilMs: 20_000,
      }),
    }).execute();

    expect(report).toMatchObject({
      drainState: 'branch-blocked',
      recovery: { generationId: 'generation-1', providerRevision: 29, retryable: false },
    });
  });

  it.each([
    ['account_creation_limit', 'capacity'],
    ['policy_blocked', 'policy'],
  ] as const)('withholds a manual fence for an already claimed %s probe', async (blockReason, failureClass) => {
    const report = await statusUseCase({
      provider: providerState({
        revision: 41,
        blockReason,
        failureClass,
        failureStreak: 1,
        cooldownUntilMs: 20_000,
      }),
    }).execute();

    expect(report).toMatchObject({
      recovery: { generationId: 'generation-1', providerRevision: 41, retryable: false },
    });
  });

  it('keeps quota recovery automatic and reauthorization outside manual retry', async () => {
    const quota = await statusUseCase({
      provider: providerState({ revision: 31, blockReason: 'quota_exhausted' }),
    }).execute();
    const reauthorization = await statusUseCase({
      provider: providerState({ revision: 37, blockReason: 'reauthorization_required' }),
    }).execute();

    expect(quota).toMatchObject({
      requiredAction: 'free-drive-space',
      recovery: { generationId: 'generation-1', providerRevision: 31, retryable: false },
    });
    expect(reauthorization).toMatchObject({
      requiredAction: 'reauthorize',
      recovery: { generationId: 'generation-1', providerRevision: 37, retryable: false },
    });
  });

  it('reports permissionId even when presentation fields are absent', async () => {
    const connections = {
      listStatusConnections: async () => [{
        id: 'generation-1',
        installationId: 'installation-1',
        status: 'active' as const,
        revision: 0,
        permissionId: 'perm-1',
        email: null,
        displayName: null,
        folders: { rootId: 'root-1', motionId: 'motion-1', backupsId: 'backups-1' },
        createdAtMs: 1,
        updatedAtMs: 2,
        activatedAtMs: 2,
        retiredAtMs: null,
        errorCode: null,
      }],
      readQuotaReclamation: async () => ({ windowStartedMs: 10, reclaimedBytes: 20 }),
    };
    const artifacts = {
      readStatusCounts: async () => ({
        artifacts: { pending: 1, archived: 2, failed: 0 },
        attempts: { pending: 1, uploading: 0, retryable: 0, verified: 2, missing: 0, detached: 0, conflict: 0, abandoned: 0, deleted: 0 },
      }),
      readSchedulerState: async () => ({
        revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null,
        lastBackupSuccessMs: 3, lastUploadSuccessMs: 4,
        lastReconcileSuccessMs: 5, lastCleanupSuccessMs: 6,
        lastMotionTraversalSuccessMs: 7, lastArtifactRegistrationSuccessMs: 8,
      }),
      readQueueStatus: async () => ({
        queuedVideos: 12, retryableVideos: 3, oldestQueuedVideoAtMs: 9_000,
        branchBlocked: true,
      }),
      readUnhealthyDateFolderCount: async () => 2,
    };
    const account = {
      readQuota: async () => ({
        limitBytes: 100, usageBytes: 70, usageInDriveBytes: 60, usageInDriveTrashBytes: 10,
      }),
    };
    const provider = {
      load: async () => ({
        revision: 1, generationId: 'generation-1', operationClass: 'upload' as const,
        failureClass: null, failureStreak: 0, cooldownUntilMs: null,
        blockReason: null, updatedAtMs: 8_000,
      }),
    };
    const useCase = new ReportDriveStatusUseCase(
      connections,
      artifacts as never,
      account,
      provider,
      { now: () => new Date(10_000) },
    );

    const report = await useCase.execute();

    expect(report.account).toEqual({ permissionId: 'perm-1', email: null, displayName: null });
    expect(report.folders).toEqual({
      root: 'https://drive.google.com/drive/folders/root-1',
      motion: 'https://drive.google.com/drive/folders/motion-1',
      backups: 'https://drive.google.com/drive/folders/backups-1',
    });
    expect(report.quota).toEqual({ limitBytes: 100, usageBytes: 70, usageInDriveBytes: 60, usageInDriveTrashBytes: 10 });
    expect(report.last).toMatchObject({ motionTraversalAtMs: 7, artifactRegistrationAtMs: 8 });
    expect(report.queue).toEqual({
      queuedVideos: 12, retryableVideos: 3,
      oldestQueuedVideoAgeMs: 1_000, unhealthyDateFolders: 2,
    });
    expect(report.drainState).toBe('branch-blocked');
  });

  it.each([
    ['reauthorization_required', 'authorization', null, 'reauthorization-required'],
    ['policy_blocked', 'policy', null, 'policy-blocked'],
    ['account_creation_limit', 'capacity', null, 'capacity-blocked'],
    ['quota_exhausted', 'quota', null, 'quota-blocked'],
    [null, 'rate-limit', 20_000, 'cooling-down'],
  ] as const)('projects provider state %s without exposing its raw reason', async (
    blockReason,
    failureClass,
    cooldownUntilMs,
    expected,
  ) => {
    const useCase = new ReportDriveStatusUseCase(
      activeConnections(),
      aggregateArtifacts(),
      { readQuota: async () => null },
      {
        load: async () => ({
          revision: 1, generationId: 'generation-1', operationClass: 'upload' as const,
          failureClass, failureStreak: 1, cooldownUntilMs, blockReason,
          updatedAtMs: 9_000,
        }),
      },
      { now: () => new Date(10_000) },
    );

    const report = await useCase.execute();

    expect(report.drainState).toBe(expected);
    expect(JSON.stringify({ queue: report.queue, drainState: report.drainState }))
      .not.toContain(blockReason ?? 'provider-body-secret');
  });

  it('treats the durable connection reauthorization state as the highest-priority block', async () => {
    const connections = activeConnections();
    connections.listStatusConnections = async () => [{
      ...(await activeConnections().listStatusConnections())[0],
      status: 'reauth_required' as const,
      errorCode: 'authorization_required',
    }];
    const useCase = new ReportDriveStatusUseCase(
      connections,
      aggregateArtifacts(),
      { readQuota: async () => null },
      {
        load: async () => ({
          revision: 0, generationId: null, operationClass: null, failureClass: null,
          failureStreak: 0, cooldownUntilMs: null, blockReason: null, updatedAtMs: 0,
        }),
      },
      { now: () => new Date(10_000) },
    );

    await expect(useCase.execute()).resolves.toMatchObject({
      drainState: 'reauthorization-required',
    });
  });

  it('keeps a clear same-generation provider row outside manual recovery during connection reauthorization', async () => {
    const connections = activeConnections();
    connections.listStatusConnections = async () => [{
      ...(await activeConnections().listStatusConnections())[0],
      status: 'reauth_required' as const,
      errorCode: 'authorization_required',
    }];

    const report = await statusUseCase({
      connections,
      provider: providerState({ revision: 47, operationClass: null }),
    }).execute();

    expect(report).toMatchObject({
      drainState: 'reauthorization-required',
      requiredAction: 'reauthorize',
      recovery: { generationId: 'generation-1', providerRevision: 47, retryable: false },
    });
  });

  it.each([
    ['expired global row', 1, null, 'idle'],
    ['retired generation activity', 0, { generationId: 'generation-retired', artifactKind: 'motion_video', startedAtMs: 9_000 }, 'idle'],
    ['current backup activity', 0, { generationId: 'generation-1', artifactKind: 'database_backup', startedAtMs: 9_000 }, 'idle'],
    ['current video activity before an uploading row exists', 0, { generationId: 'generation-1', artifactKind: 'motion_video', startedAtMs: 9_000 }, 'active'],
  ] as const)('uses the scheduler snapshot for %s', async (
    _scenario,
    uploading,
    activity,
    expected,
  ) => {
    const artifacts = aggregateArtifacts();
    artifacts.readStatusCounts = async () => ({
      artifacts: { stabilizing: 0, pending: 1, verified: 0, local_missing: 0, superseded: 0 },
      attempts: { pending: 0, uploading, retryable: 0, verified: 0, missing: 0, detached: 0, conflict: 0, abandoned: 0, deleted: 0 },
    });
    const useCase = statusUseCase({
      artifacts,
      activity: { readActivitySnapshot: () => activity },
    });

    await expect(useCase.execute()).resolves.toMatchObject({ drainState: expected });
  });

  it('reports a transient cooldown owned by any Drive operation', async () => {
    const useCase = statusUseCase({
      provider: {
        load: async () => ({
          revision: 1, generationId: 'generation-1', operationClass: 'delete' as const,
          failureClass: 'rate-limit' as const, failureStreak: 1,
          cooldownUntilMs: 20_000, blockReason: null, updatedAtMs: 9_000,
        }),
      },
    });

    await expect(useCase.execute()).resolves.toMatchObject({ drainState: 'cooling-down' });
  });

  it('retries assembly when the active generation changes before return', async () => {
    let reads = 0;
    const connections = activeConnections();
    connections.listStatusConnections = async () => {
      reads += 1;
      return activeStatusConnections(reads === 1 ? 'generation-1' : 'generation-2');
    };
    const useCase = statusUseCase({ connections });

    const report = await useCase.execute();

    expect(reads).toBeGreaterThanOrEqual(3);
    expect(report.connection?.generationId).toBe('generation-2');
  });
});

function statusUseCase(overrides: {
  connections?: ReturnType<typeof activeConnections>;
  artifacts?: ReturnType<typeof aggregateArtifacts>;
  provider?: { load(): Promise<{
    revision: number; generationId: string | null; operationClass: 'account' | 'folder' | 'upload' | 'reconcile' | 'delete' | null;
    failureClass: 'transport' | 'rate-limit' | 'quota' | 'capacity' | 'authorization' | 'policy' | null;
    failureStreak: number; cooldownUntilMs: number | null; blockReason: string | null; updatedAtMs: number;
  }> };
  account?: { readQuota(): Promise<unknown> };
  activity?: { readActivitySnapshot(): unknown };
} = {}): ReportDriveStatusUseCase {
  const Constructor = ReportDriveStatusUseCase as unknown as new (
    connections: ReturnType<typeof activeConnections>,
    artifacts: ReturnType<typeof aggregateArtifacts>,
    account: { readQuota(): Promise<unknown> },
    provider: NonNullable<typeof overrides.provider>,
    clock: { now(): Date },
    activity: NonNullable<typeof overrides.activity>,
  ) => ReportDriveStatusUseCase;
  return new Constructor(
    overrides.connections ?? activeConnections(),
    overrides.artifacts ?? aggregateArtifacts(),
    overrides.account ?? { readQuota: async () => null },
    overrides.provider ?? {
      load: async () => ({
        revision: 0, generationId: null, operationClass: null, failureClass: null,
        failureStreak: 0, cooldownUntilMs: null, blockReason: null, updatedAtMs: 0,
      }),
    },
    { now: () => new Date(10_000) },
    overrides.activity ?? { readActivitySnapshot: () => null },
  );
}

function activeConnections() {
  return {
    listStatusConnections: async () => activeStatusConnections('generation-1'),
    readQuotaReclamation: async () => null,
  };
}

function activeStatusConnections(id: string) {
  return [{
    id, installationId: 'installation-1', status: 'active' as const,
    revision: 0, permissionId: `perm-${id}`, email: null, displayName: null,
    folders: { rootId: 'root-1', motionId: 'motion-1', backupsId: 'backups-1' },
    createdAtMs: 1, updatedAtMs: 2, activatedAtMs: 2, retiredAtMs: null,
    errorCode: null,
  }];
}

function providerState(overrides: {
  revision?: number;
  blockReason?: 'quota_exhausted' | 'account_creation_limit' | 'policy_blocked' | 'reauthorization_required' | null;
  failureClass?: 'transport' | 'rate-limit' | 'quota' | 'capacity' | 'authorization' | 'policy' | null;
  failureStreak?: number;
  cooldownUntilMs?: number | null;
  operationClass?: 'account' | 'folder' | 'upload' | 'reconcile' | 'delete' | null;
} = {}) {
  return {
    load: async () => ({
      revision: overrides.revision ?? 1,
      generationId: 'generation-1',
      operationClass: overrides.operationClass === undefined ? 'upload' : overrides.operationClass,
      failureClass: overrides.failureClass ?? null,
      failureStreak: overrides.failureStreak ?? 0,
      cooldownUntilMs: overrides.cooldownUntilMs ?? null,
      blockReason: overrides.blockReason ?? null, updatedAtMs: 9_000,
    }),
  };
}

function schedulerState() {
  return {
    revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null,
    lastBackupSuccessMs: null, lastUploadSuccessMs: null,
    lastReconcileSuccessMs: null, lastCleanupSuccessMs: null,
    lastMotionTraversalSuccessMs: null, lastArtifactRegistrationSuccessMs: null,
    lastPlausibleWallTimeMs: null, clockHealth: 'healthy' as const,
    observedRollbackMs: null,
  };
}

function aggregateArtifacts() {
  return {
    readStatusCounts: async () => ({
      artifacts: { stabilizing: 0, pending: 1, verified: 0, local_missing: 0, superseded: 0 },
      attempts: { pending: 0, uploading: 0, retryable: 0, verified: 0, missing: 0, detached: 0, conflict: 0, abandoned: 0, deleted: 0 },
    }),
    readSchedulerState: async () => schedulerState(),
    readQueueStatus: async () => ({
      queuedVideos: 1, retryableVideos: 0, oldestQueuedVideoAtMs: 9_000,
      branchBlocked: false,
    }),
    readUnhealthyDateFolderCount: async () => 0,
  };
}
