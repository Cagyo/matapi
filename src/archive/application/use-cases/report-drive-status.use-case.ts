import { Inject, Injectable } from '@nestjs/common';
import { DriveConnection } from '../../domain/drive-connection.entity';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
  type ArchiveStatusCounts,
} from '../ports/archive-artifact-repository.port';
import {
  DRIVE_ACCOUNT,
  type DriveAccountPort,
  type DriveQuota,
} from '../ports/drive-account.port';
import {
  DRIVE_CREDENTIAL_REPOSITORY,
  type DriveCredentialRepositoryPort,
  type DriveStatusConnection,
} from '../ports/drive-credential-repository.port';

export interface DriveStatusReport {
  connection: { generationId: string; state: string; errorCode: string | null } | null;
  account: { permissionId: string; email: string | null; displayName: string | null } | null;
  folders: { root: string; motion: string; backups: string } | null;
  last: { refreshAtMs: number | null; uploadAtMs: number | null; backupAtMs: number | null; reconcileAtMs: number | null; cleanupAtMs: number | null };
  artifacts: ArchiveStatusCounts['artifacts'];
  attempts: ArchiveStatusCounts['attempts'];
  generations: readonly { generationId: string; state: string; retiredAtMs: number | null }[];
  quota: DriveQuota | null;
  reclamation: { windowStartedMs: number | null; reclaimedBytes: number } | null;
  requiredActions: readonly ('reauthorize' | 'check-clock' | 'manual-cleanup')[];
}

/** Read-only, sanitized Drive projection. It never reads encrypted credentials. */
@Injectable()
export class ReportDriveStatusUseCase {
  constructor(
    @Inject(DRIVE_CREDENTIAL_REPOSITORY)
    private readonly connections: Pick<
      DriveCredentialRepositoryPort,
      'listStatusConnections' | 'readQuotaReclamation'
    >,
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY)
    private readonly artifacts: Pick<
      ArchiveArtifactRepositoryPort,
      'readStatusCounts' | 'readSchedulerState'
    >,
    @Inject(DRIVE_ACCOUNT)
    private readonly account: Pick<DriveAccountPort, 'readQuota'>,
  ) {}

  async execute(signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<DriveStatusReport> {
    const [connections, counts, scheduler] = await Promise.all([
      this.connections.listStatusConnections(),
      this.artifacts.readStatusCounts(),
      this.artifacts.readSchedulerState(),
    ]);
    const active = connections.find((connection) =>
      connection.status === 'active' || connection.status === 'reauth_required',
    ) ?? null;
    const [quota, reclamation] = active === null
      ? [null, null]
      : await Promise.all([
        active.status === 'active'
          ? this.account.readQuota(toConnection(active), signal).catch(() => null)
          : Promise.resolve(null),
        this.connections.readQuotaReclamation(active.id),
      ]);

    return {
      connection: active === null
        ? null
        : { generationId: active.id, state: active.status, errorCode: active.errorCode },
      account: active?.permissionId === null || active === null
        ? null
        : { permissionId: active.permissionId, email: active.email, displayName: active.displayName },
      folders: active?.folders === null || active === null
        ? null
        : folderLinks(active.folders),
      last: {
        refreshAtMs: active?.updatedAtMs ?? null,
        uploadAtMs: scheduler.lastUploadSuccessMs,
        backupAtMs: scheduler.lastBackupSuccessMs,
        reconcileAtMs: scheduler.lastReconcileSuccessMs,
        cleanupAtMs: scheduler.lastCleanupSuccessMs,
      },
      artifacts: counts.artifacts,
      attempts: counts.attempts,
      generations: connections
        .filter((connection) => connection.status === 'retired_unmanaged' || connection.status === 'disconnected')
        .map((connection) => ({ generationId: connection.id, state: connection.status, retiredAtMs: connection.retiredAtMs })),
      quota,
      reclamation,
      requiredActions: requiredActions(active, connections, counts),
    };
  }
}

function toConnection(connection: DriveStatusConnection): DriveConnection {
  return DriveConnection.restore({
    id: connection.id,
    installationId: connection.installationId,
    status: connection.status,
    revision: connection.revision,
    permissionId: connection.permissionId,
    email: connection.email,
    displayName: connection.displayName,
    folders: connection.folders,
    createdAtMs: connection.createdAtMs,
    updatedAtMs: connection.updatedAtMs,
    activatedAtMs: connection.activatedAtMs,
    retiredAtMs: connection.retiredAtMs,
  });
}

function folderLinks(folders: NonNullable<DriveStatusConnection['folders']>) {
  return {
    root: `https://drive.google.com/drive/folders/${folders.rootId}`,
    motion: `https://drive.google.com/drive/folders/${folders.motionId}`,
    backups: `https://drive.google.com/drive/folders/${folders.backupsId}`,
  };
}

function requiredActions(
  active: DriveStatusConnection | null,
  connections: readonly DriveStatusConnection[],
  counts: ArchiveStatusCounts,
): readonly ('reauthorize' | 'check-clock' | 'manual-cleanup')[] {
  const actions: ('reauthorize' | 'check-clock' | 'manual-cleanup')[] = [];
  if (active?.status === 'reauth_required' || active?.errorCode === 'authorization_required') actions.push('reauthorize');
  if (connections.some((connection) => connection.errorCode === 'clock_unhealthy')) actions.push('check-clock');
  if (counts.attempts.missing > 0 || counts.attempts.detached > 0) actions.push('manual-cleanup');
  return actions;
}
