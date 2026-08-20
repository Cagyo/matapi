import { describe, expect, it } from 'vitest';
import {
  deriveArchiveDrainState,
  ReportDriveStatusUseCase,
} from '../../../src/archive/application/use-cases/report-drive-status.use-case';

describe('ReportDriveStatusUseCase', () => {
  it.each([
    ['reauthorization_required', 'reauthorization-required'],
    ['policy_blocked', 'policy-blocked'],
    ['capacity_blocked', 'capacity-blocked'],
    ['quota_blocked', 'quota-blocked'],
    ['active', 'active'],
    ['branch_blocked', 'branch-blocked'],
    ['cooling_down', 'cooling-down'],
    ['idle', 'idle'],
  ] as const)('applies drain-state precedence for %s', (scenario, expected) => {
    const input = {
      providerBlock: scenario === 'reauthorization_required' ? 'reauthorization-required' as const
        : scenario === 'policy_blocked' ? 'policy-blocked' as const
          : scenario === 'capacity_blocked' ? 'capacity-blocked' as const
            : scenario === 'quota_blocked' ? 'quota-blocked' as const : null,
      hasActiveTransfer: scenario === 'active',
      queuedVideos: scenario === 'idle' ? 0 : 1,
      branchBlocked: scenario === 'branch_blocked',
      coolingDown: scenario === 'cooling_down',
    };

    expect(deriveArchiveDrainState(input)).toBe(expected);
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
});

function activeConnections() {
  return {
    listStatusConnections: async () => [{
      id: 'generation-1', installationId: 'installation-1', status: 'active' as const,
      revision: 0, permissionId: 'perm-1', email: null, displayName: null,
      folders: { rootId: 'root-1', motionId: 'motion-1', backupsId: 'backups-1' },
      createdAtMs: 1, updatedAtMs: 2, activatedAtMs: 2, retiredAtMs: null,
      errorCode: null,
    }],
    readQuotaReclamation: async () => null,
  };
}

function aggregateArtifacts() {
  return {
    readStatusCounts: async () => ({
      artifacts: { stabilizing: 0, pending: 1, verified: 0, local_missing: 0, superseded: 0 },
      attempts: { pending: 0, uploading: 0, retryable: 0, verified: 0, missing: 0, detached: 0, conflict: 0, abandoned: 0, deleted: 0 },
    }),
    readSchedulerState: async () => ({
      revision: 0, backupLeaseOwner: null, backupLeaseExpiresAtMs: null,
      lastBackupSuccessMs: null, lastUploadSuccessMs: null,
      lastReconcileSuccessMs: null, lastCleanupSuccessMs: null,
      lastMotionTraversalSuccessMs: null, lastArtifactRegistrationSuccessMs: null,
    }),
    readQueueStatus: async () => ({
      queuedVideos: 1, retryableVideos: 0, oldestQueuedVideoAtMs: 9_000,
      branchBlocked: false,
    }),
    readUnhealthyDateFolderCount: async () => 0,
  };
}
