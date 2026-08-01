import { Inject, Injectable } from '@nestjs/common';
import type { ArchiveArtifact } from '../../domain/archive-artifact.entity';
import type { DriveConnection } from '../../domain/drive-connection.entity';
import { DriveClockUnhealthyError } from '../../domain/errors/drive-clock-unhealthy.error';
import { DriveObjectConflictError } from '../../domain/errors/drive-object-conflict.error';
import { DriveQuotaExceededError } from '../../domain/errors/drive-quota-exceeded.error';
import {
  classifyRemoteObject,
  hasUnchangedTrustedSource,
} from '../archive-object-verification';
import type { ArchiveRemoteMutationLockService } from '../archive-remote-mutation-lock.service';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
  type ArchiveObjectAttempt,
} from '../ports/archive-artifact-repository.port';
import {
  ARCHIVE_CLOCK,
  type ArchiveClockPort,
} from '../ports/archive-clock.port';
import {
  DRIVE_ACCOUNT,
  type DriveAccountPort,
  type DriveQuota,
} from '../ports/drive-account.port';
import {
  DRIVE_ARCHIVE,
  type DriveArchivePort,
} from '../ports/drive-archive.port';
import {
  DRIVE_CREDENTIAL_REPOSITORY,
  type DriveCredentialRepositoryPort,
  type DriveQuotaReclamationState,
} from '../ports/drive-credential-repository.port';
import {
  ARCHIVE_UPLOAD_SOURCE,
  type ArchiveUploadSourcePort,
} from './upload-drive-object-attempt.use-case';
import type {
  ArchiveRetentionInput,
  ArchiveRetentionPort,
  ArchiveRetentionResult,
} from '../ports/archive-retention.port';

const DAY_MS = 24 * 60 * 60 * 1_000;
const BACKUP_RETENTION_MS = 7 * DAY_MS;
const VIDEO_RETENTION_MS = 90 * DAY_MS;
const ACCOUNTING_WINDOW_MS = 72 * 60 * 60 * 1_000;
const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1_000;

type RetentionRepository = Pick<ArchiveArtifactRepositoryPort,
  'listRetentionCandidates' | 'loadAttempt' | 'loadArtifact' | 'markDetached' |
  'markDeleted' | 'readSchedulerState'>;
type RetentionCredentials = Pick<DriveCredentialRepositoryPort,
  'loadActive' | 'readQuotaReclamation' | 'compareAndSetQuotaReclamation'>;
type RetentionDrive = Pick<DriveArchivePort, 'loadObject' | 'deleteExact'>;

export interface ApplyDriveRetentionOptions {
  candidateLimit?: number;
  clockSkewMs?: number;
}

interface Candidate {
  attempt: ArchiveObjectAttempt;
  artifact: ArchiveArtifact;
}

/** Applies only bounded exact-ID retention after clock, quota, and ownership checks. */
@Injectable()
export class ApplyDriveRetentionUseCase implements ArchiveRetentionPort {
  private readonly candidateLimit: number;
  private readonly clockSkewMs: number;

  constructor(
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY)
    private readonly repository: RetentionRepository,
    @Inject(DRIVE_CREDENTIAL_REPOSITORY)
    private readonly credentials: RetentionCredentials,
    @Inject(DRIVE_ACCOUNT)
    private readonly account: Pick<DriveAccountPort, 'readQuota'>,
    @Inject(DRIVE_ARCHIVE)
    private readonly drive: RetentionDrive,
    @Inject(ARCHIVE_UPLOAD_SOURCE)
    private readonly source: ArchiveUploadSourcePort,
    @Inject(ARCHIVE_CLOCK)
    private readonly clock: ArchiveClockPort,
    private readonly lock: Pick<ArchiveRemoteMutationLockService, 'tryRunCleanup' | 'runExclusive'>,
    options: ApplyDriveRetentionOptions = {},
  ) {
    this.candidateLimit = positive(options.candidateLimit ?? 1_000, 'candidate limit');
    this.clockSkewMs = nonNegative(options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS, 'clock skew');
  }

  async execute(
    input: ArchiveRetentionInput,
    signal: AbortSignal,
  ): Promise<ArchiveRetentionResult> {
    const requiredBytes = nonNegative(input.requiredBytes, 'required bytes');
    throwIfAborted(signal);
    const clock = await this.clock.read();
    if (!healthyClock(clock)) throw new DriveClockUnhealthyError();
    const nowMs = clock.nowMs;
    const active = await this.credentials.loadActive();
    if (!manageable(active)) return result([], 0, 0, false);
    const quota = await this.account.readQuota(active, signal);
    validateQuota(quota);
    const availableBytes = Math.max(0, quota.limitBytes! - quota.usageBytes);
    const deficitBytes = Math.max(0, requiredBytes - availableBytes);
    let accounting = await this.credentials.readQuotaReclamation(active.id);
    if (accounting === null) throw new DriveObjectConflictError('Drive quota accounting state is missing');

    if (accounting.windowStartedMs !== null) {
      const scheduler = await this.repository.readSchedulerState();
      const uploadCaughtUp = scheduler.lastUploadSuccessMs !== null &&
        scheduler.lastUploadSuccessMs > accounting.windowStartedMs;
      const quotaCaughtUp = requiredBytes > 0 && availableBytes >= requiredBytes;
      const expired = nowMs - accounting.windowStartedMs >= ACCOUNTING_WINDOW_MS;
      if (!uploadCaughtUp && !quotaCaughtUp && !expired) {
        return result([], 0, deficitBytes, true);
      }
      const cleared = await this.credentials.compareAndSetQuotaReclamation({
        generationId: active.id,
        expected: accounting,
        next: emptyAccounting(),
      });
      if (!cleared) return result([], 0, deficitBytes, true);
      accounting = emptyAccounting();
    }

    const candidates = await this.discover(active, nowMs, signal);
    const expiredBackups = candidates.backups.filter(({ attempt }) =>
      attempt.verifiedObject!.providerCreatedAtMs < nowMs - BACKUP_RETENTION_MS,
    );
    const oldVideos = candidates.videos.filter(({ attempt }) =>
      attempt.verifiedObject!.providerCreatedAtMs < nowMs - VIDEO_RETENTION_MS,
    );
    const youngVideos: Candidate[] = [];
    let eligibleBytes = [...expiredBackups, ...oldVideos].reduce(
      (sum, candidate) => sum + candidate.attempt.verifiedObject!.size,
      0,
    );
    if (deficitBytes > eligibleBytes) {
      for (const candidate of candidates.videos) {
        if (candidate.attempt.verifiedObject!.providerCreatedAtMs < nowMs - VIDEO_RETENTION_MS) continue;
        if (await hasUnchangedTrustedSource(candidate.artifact, this.source, signal)) {
          youngVideos.push(candidate);
          eligibleBytes += candidate.attempt.verifiedObject!.size;
          if (eligibleBytes >= deficitBytes) break;
        }
      }
    }

    const selected = selectCandidates(expiredBackups, oldVideos, youngVideos, deficitBytes);
    const deletedIds: string[] = [];
    let reclaimedBytes = 0;
    let durableAccounting = accounting;
    for (const candidate of selected) {
      throwIfAborted(signal);
      const deletion = await this.lock.tryRunCleanup(async () => {
        if (isYoungVideo(candidate, nowMs) &&
          !(await hasUnchangedTrustedSource(candidate.artifact, this.source, signal))) return 0;
        return this.lock.runExclusive(async () => {
          const current = await this.credentials.loadActive();
          if (!sameManageableGeneration(current, active)) return 0;
          const attempt = await this.repository.loadAttempt(candidate.attempt.id);
          if (!sameDeletableAttempt(attempt, candidate.attempt)) return 0;
          const artifact = await this.repository.loadArtifact(attempt.artifactId);
          if (!sameOwnedArtifact(artifact, attempt, current)) return 0;
          let startedAccounting = false;
          if (deficitBytes > 0 && durableAccounting.windowStartedMs === null) {
            const started = { windowStartedMs: nowMs, reclaimedBytes: 0 };
            if (!(await this.credentials.compareAndSetQuotaReclamation({
              generationId: current.id,
              expected: durableAccounting,
              next: started,
            }))) return 0;
            durableAccounting = started;
            startedAccounting = true;
          }
          const remote = await this.drive.loadObject(current, attempt.remoteObjectId, signal);
          if (classifyRemoteObject(artifact, attempt, current, remote) !== 'exact') {
            await this.repository.markDetached(
              attempt.id,
              attempt.revision,
              'retention_revalidation_failed',
              nowMs,
            );
            if (startedAccounting && await this.credentials.compareAndSetQuotaReclamation({
              generationId: current.id,
              expected: durableAccounting,
              next: emptyAccounting(),
            })) durableAccounting = emptyAccounting();
            return 0;
          }
          await this.drive.deleteExact(current, attempt.remoteObjectId, signal);
          await this.repository.markDeleted(attempt.id, attempt.revision, nowMs);
          if (deficitBytes > 0) {
            const next = {
              windowStartedMs: durableAccounting.windowStartedMs,
              reclaimedBytes: durableAccounting.reclaimedBytes + attempt.verifiedObject.size,
            };
            if (!(await this.credentials.compareAndSetQuotaReclamation({
              generationId: current.id,
              expected: durableAccounting,
              next,
            }))) {
              throw new DriveObjectConflictError('Drive quota accounting changed after deletion');
            }
            durableAccounting = next;
          }
          return attempt.verifiedObject.size;
        });
      });
      if (deletion === null) break;
      if (deletion > 0) {
        deletedIds.push(candidate.attempt.remoteObjectId);
        reclaimedBytes += deletion;
      }
    }
    return result(
      deletedIds,
      reclaimedBytes,
      Math.max(0, deficitBytes - reclaimedBytes),
      durableAccounting.windowStartedMs !== null,
    );
  }

  private async discover(
    active: DriveConnection,
    nowMs: number,
    signal: AbortSignal,
  ): Promise<{ backups: Candidate[]; videos: Candidate[] }> {
    const [backupAttempts, videoAttempts] = await Promise.all([
      this.repository.listRetentionCandidates({
        kind: 'database_backup', limit: this.candidateLimit, generationId: active.id,
      }),
      this.repository.listRetentionCandidates({
        kind: 'motion_video', limit: this.candidateLimit, generationId: active.id,
      }),
    ]);
    const load = async (attempts: readonly ArchiveObjectAttempt[]): Promise<Candidate[]> => {
      const result: Candidate[] = [];
      for (const attempt of attempts) {
        throwIfAborted(signal);
        const providerTime = attempt.verifiedObject?.providerCreatedAtMs;
        if (!validProviderTime(providerTime, nowMs, this.clockSkewMs)) {
          throw new DriveClockUnhealthyError('Drive creation time is missing or invalid');
        }
        if (attempt.state !== 'verified' || attempt.generationId !== active.id) continue;
        const artifact = await this.repository.loadArtifact(attempt.artifactId);
        if (artifact?.currentVerifiedAttemptId !== attempt.id || artifact.installationId !== active.installationId) continue;
        result.push({ attempt, artifact });
      }
      return result.sort(candidateOrder);
    };
    return { backups: await load(backupAttempts), videos: await load(videoAttempts) };
  }
}

function selectCandidates(
  backups: readonly Candidate[],
  oldVideos: readonly Candidate[],
  youngVideos: readonly Candidate[],
  deficitBytes: number,
): Candidate[] {
  if (deficitBytes === 0) return [...backups];
  const ordered = [...backups, ...oldVideos, ...youngVideos];
  const eligibleBytes = ordered.reduce((sum, candidate) =>
    sum + candidate.attempt.verifiedObject!.size, 0);
  if (eligibleBytes < deficitBytes) return [...backups];
  const selected: Candidate[] = [];
  let bytes = 0;
  for (const candidate of ordered) {
    selected.push(candidate);
    bytes += candidate.attempt.verifiedObject!.size;
    if (bytes >= deficitBytes) break;
  }
  return selected;
}

function candidateOrder(left: Candidate, right: Candidate): number {
  return left.attempt.verifiedObject!.providerCreatedAtMs -
    right.attempt.verifiedObject!.providerCreatedAtMs ||
    left.attempt.id.localeCompare(right.attempt.id);
}

function isYoungVideo(candidate: Candidate, nowMs: number): boolean {
  return candidate.artifact.kind === 'motion_video' &&
    candidate.attempt.verifiedObject!.providerCreatedAtMs >= nowMs - VIDEO_RETENTION_MS;
}

function manageable(connection: DriveConnection | null): connection is DriveConnection {
  return connection?.status === 'active' && connection.folders !== null && connection.permissionId !== null;
}

function sameManageableGeneration(
  current: DriveConnection | null,
  selected: DriveConnection,
): current is DriveConnection {
  return manageable(current) && current.id === selected.id &&
    current.installationId === selected.installationId &&
    current.permissionId === selected.permissionId &&
    current.folders!.rootId === selected.folders!.rootId &&
    current.folders!.motionId === selected.folders!.motionId &&
    current.folders!.backupsId === selected.folders!.backupsId;
}

function sameDeletableAttempt(
  current: ArchiveObjectAttempt | null,
  selected: ArchiveObjectAttempt,
): current is ArchiveObjectAttempt & { verifiedObject: NonNullable<ArchiveObjectAttempt['verifiedObject']> } {
  return current !== null && current.state === 'verified' && current.verifiedObject !== null &&
    current.id === selected.id && current.artifactId === selected.artifactId &&
    current.generationId === selected.generationId &&
    current.remoteObjectId === selected.remoteObjectId;
}

function sameOwnedArtifact(
  artifact: ArchiveArtifact | null,
  attempt: ArchiveObjectAttempt,
  connection: DriveConnection,
): artifact is ArchiveArtifact {
  return artifact !== null && artifact.state === 'verified' &&
    artifact.currentVerifiedAttemptId === attempt.id &&
    artifact.installationId === connection.installationId &&
    attempt.generationId === connection.id;
}

function healthyClock(reading: Awaited<ReturnType<ArchiveClockPort['read']>>): boolean {
  return Number.isSafeInteger(reading.nowMs) && reading.nowMs >= 0 &&
    reading.synchronized === true && reading.plausible === true &&
    (reading.offsetMs === null || (Number.isSafeInteger(reading.offsetMs) && Number.isFinite(reading.offsetMs)));
}

function validProviderTime(value: unknown, nowMs: number, clockSkewMs: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= nowMs + clockSkewMs;
}

function validateQuota(quota: DriveQuota): void {
  const values = [quota.limitBytes, quota.usageBytes, quota.usageInDriveBytes, quota.usageInDriveTrashBytes];
  if (quota.limitBytes === null || values.some((value) =>
    typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0,
  ) || quota.usageInDriveBytes > quota.usageBytes ||
    quota.usageInDriveTrashBytes > quota.usageInDriveBytes) {
    throw new DriveQuotaExceededError('Drive quota metadata is unavailable or inconsistent');
  }
}

function emptyAccounting(): DriveQuotaReclamationState {
  return { windowStartedMs: null, reclaimedBytes: 0 };
}

function result(
  deletedIds: readonly string[],
  reclaimedBytes: number,
  remainingDeficitBytes: number,
  accountingWindowActive: boolean,
): ArchiveRetentionResult {
  return { deletedIds, reclaimedBytes, remainingDeficitBytes, accountingWindowActive };
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Archive retention ${label} is invalid`);
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Archive retention ${label} is invalid`);
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}
