import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type ClockPort } from '../../../events/domain/ports/clock.port';
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
import {
  ARCHIVE_PROVIDER_STATE_REPOSITORY,
  type ArchiveProviderState,
  type ArchiveProviderStateRepositoryPort,
} from '../ports/archive-provider-state-repository.port';

export type ArchiveDrainState =
  | 'active'
  | 'idle'
  | 'cooling-down'
  | 'branch-blocked'
  | 'quota-blocked'
  | 'capacity-blocked'
  | 'policy-blocked'
  | 'reauthorization-required';

export interface ArchiveSchedulerActivitySnapshot {
  generationId: string;
  artifactKind: 'motion_video' | 'database_backup';
  startedAtMs: number;
}

export interface ArchiveSchedulerActivityReader {
  readActivitySnapshot(): ArchiveSchedulerActivitySnapshot | null;
}

export interface DriveStatusReport {
  connection: { generationId: string; state: string; errorCode: string | null } | null;
  account: { permissionId: string; email: string | null; displayName: string | null } | null;
  folders: { root: string; motion: string; backups: string } | null;
  last: {
    refreshAtMs: number | null;
    uploadAtMs: number | null;
    backupAtMs: number | null;
    reconcileAtMs: number | null;
    cleanupAtMs: number | null;
    motionTraversalAtMs: number | null;
    artifactRegistrationAtMs: number | null;
  };
  artifacts: ArchiveStatusCounts['artifacts'];
  attempts: ArchiveStatusCounts['attempts'];
  generations: readonly { generationId: string; state: string; retiredAtMs: number | null }[];
  quota: DriveQuota | null;
  reclamation: { windowStartedMs: number | null; reclaimedBytes: number } | null;
  requiredActions: readonly ('reauthorize' | 'check-clock' | 'manual-cleanup')[];
  queue: {
    queuedVideos: number;
    retryableVideos: number;
    oldestQueuedVideoAgeMs: number | null;
    unhealthyDateFolders: number;
  };
  drainState: ArchiveDrainState;
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
      'readStatusCounts' | 'readSchedulerState' | 'readQueueStatus' |
      'readUnhealthyDateFolderCount'
    >,
    @Inject(DRIVE_ACCOUNT)
    private readonly account: Pick<DriveAccountPort, 'readQuota'>,
    @Optional() @Inject(ARCHIVE_PROVIDER_STATE_REPOSITORY)
    private readonly providerState: Pick<ArchiveProviderStateRepositoryPort, 'load'> = EMPTY_PROVIDER_STATE,
    @Optional() @Inject(CLOCK)
    private readonly clock: Pick<ClockPort, 'now'> = SYSTEM_CLOCK,
    @Optional()
    private readonly schedulerActivity: ArchiveSchedulerActivityReader = EMPTY_ACTIVITY,
  ) {}

  async execute(signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<DriveStatusReport> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const connections = await this.connections.listStatusConnections();
      const active = selectActive(connections);
      const report = await this.assemble(connections, active, signal);
      const confirmed = selectActive(await this.connections.listStatusConnections());
      if (sameActiveFence(active, confirmed)) return report;
    }
    throw new Error('Drive status changed during bounded assembly');
  }

  private async assemble(
    connections: readonly DriveStatusConnection[],
    active: DriveStatusConnection | null,
    signal: AbortSignal,
  ): Promise<DriveStatusReport> {
    const nowMs = this.clock.now().getTime();
    const [counts, scheduler, providerState] = await Promise.all([
      this.artifacts.readStatusCounts(),
      this.artifacts.readSchedulerState(),
      this.providerState.load(),
    ]);
    const [quota, reclamation, queue, unhealthyDateFolders] = active === null
      ? [null, null, EMPTY_QUEUE, 0] as const
      : await Promise.all([
        active.status === 'active'
          ? this.account.readQuota(toConnection(active), signal).catch(() => null)
          : Promise.resolve(null),
        this.connections.readQuotaReclamation(active.id),
        this.artifacts.readQueueStatus(active.id, nowMs),
        this.artifacts.readUnhealthyDateFolderCount(active.id),
      ]);

    const providerBlock = active?.status === 'reauth_required'
      || active?.errorCode === 'authorization_required'
      ? 'reauthorization-required'
      : providerState.generationId === active?.id
        ? providerBlockFor(providerState)
        : null;
    const coolingDown = providerState.generationId === active?.id
      && providerState.operationClass === 'upload'
      && providerState.cooldownUntilMs !== null
      && providerState.cooldownUntilMs > nowMs;
    const activity = this.schedulerActivity.readActivitySnapshot();

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
        motionTraversalAtMs: scheduler.lastMotionTraversalSuccessMs,
        artifactRegistrationAtMs: scheduler.lastArtifactRegistrationSuccessMs,
      },
      artifacts: counts.artifacts,
      attempts: counts.attempts,
      generations: connections
        .filter((connection) => connection.status === 'retired_unmanaged' || connection.status === 'disconnected')
        .map((connection) => ({ generationId: connection.id, state: connection.status, retiredAtMs: connection.retiredAtMs })),
      quota,
      reclamation,
      requiredActions: requiredActions(active, connections, counts),
      queue: {
        queuedVideos: queue.queuedVideos,
        retryableVideos: queue.retryableVideos,
        oldestQueuedVideoAgeMs: queue.oldestQueuedVideoAtMs === null
          ? null
          : Math.max(0, nowMs - queue.oldestQueuedVideoAtMs),
        unhealthyDateFolders,
      },
      drainState: deriveArchiveDrainState({
        providerBlock,
        hasActiveTransfer: active !== null
          && activity?.generationId === active.id
          && activity.artifactKind === 'motion_video',
        queuedVideos: queue.queuedVideos,
        branchBlocked: queue.branchBlocked,
        coolingDown,
      }),
    };
  }
}

export function deriveArchiveDrainState(input: {
  providerBlock: Extract<ArchiveDrainState,
    'quota-blocked' | 'capacity-blocked' | 'policy-blocked' | 'reauthorization-required'> | null;
  hasActiveTransfer: boolean;
  queuedVideos: number;
  branchBlocked: boolean;
  coolingDown: boolean;
}): ArchiveDrainState {
  if (input.providerBlock !== null) return input.providerBlock;
  if (input.hasActiveTransfer) return 'active';
  if (input.queuedVideos > 0 && input.branchBlocked) return 'branch-blocked';
  if (input.coolingDown) return 'cooling-down';
  return 'idle';
}

function providerBlockFor(state: ArchiveProviderState): Extract<ArchiveDrainState,
  'quota-blocked' | 'capacity-blocked' | 'policy-blocked' | 'reauthorization-required'> | null {
  if (state.blockReason === 'reauthorization_required') return 'reauthorization-required';
  if (state.blockReason === 'policy_blocked') return 'policy-blocked';
  if (state.blockReason === 'account_creation_limit') return 'capacity-blocked';
  if (state.blockReason === 'quota_exhausted') return 'quota-blocked';
  return null;
}

const EMPTY_QUEUE = {
  queuedVideos: 0,
  retryableVideos: 0,
  oldestQueuedVideoAtMs: null,
  branchBlocked: false,
} as const;

const EMPTY_PROVIDER_STATE: Pick<ArchiveProviderStateRepositoryPort, 'load'> = {
  load: async () => ({
    revision: 0, generationId: null, operationClass: null, failureClass: null,
    failureStreak: 0, cooldownUntilMs: null, blockReason: null, updatedAtMs: 0,
  }),
};

const SYSTEM_CLOCK: Pick<ClockPort, 'now'> = { now: () => new Date() };
const EMPTY_ACTIVITY: ArchiveSchedulerActivityReader = { readActivitySnapshot: () => null };

function selectActive(connections: readonly DriveStatusConnection[]): DriveStatusConnection | null {
  return connections.find((connection) =>
    connection.status === 'active' || connection.status === 'reauth_required',
  ) ?? null;
}

function sameActiveFence(
  first: DriveStatusConnection | null,
  second: DriveStatusConnection | null,
): boolean {
  return first?.id === second?.id
    && first?.revision === second?.revision
    && first?.status === second?.status;
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
