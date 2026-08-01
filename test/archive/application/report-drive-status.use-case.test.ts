import { describe, expect, it } from 'vitest';
import { ReportDriveStatusUseCase } from '../../../src/archive/application/use-cases/report-drive-status.use-case';

describe('ReportDriveStatusUseCase', () => {
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
      }),
    };
    const account = {
      readQuota: async () => ({
        limitBytes: 100, usageBytes: 70, usageInDriveBytes: 60, usageInDriveTrashBytes: 10,
      }),
    };
    const useCase = new ReportDriveStatusUseCase(connections, artifacts as never, account);

    const report = await useCase.execute();

    expect(report.account).toEqual({ permissionId: 'perm-1', email: null, displayName: null });
    expect(report.folders).toEqual({
      root: 'https://drive.google.com/drive/folders/root-1',
      motion: 'https://drive.google.com/drive/folders/motion-1',
      backups: 'https://drive.google.com/drive/folders/backups-1',
    });
    expect(report.quota).toEqual({ limitBytes: 100, usageBytes: 70, usageInDriveBytes: 60, usageInDriveTrashBytes: 10 });
  });
});
