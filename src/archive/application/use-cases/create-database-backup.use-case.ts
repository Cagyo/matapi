import { Inject, Injectable } from '@nestjs/common';
import { formatInTimeZone } from 'date-fns-tz';
import { createHash, randomUUID } from 'node:crypto';
import {
  DATABASE_BACKUP_SNAPSHOT,
  type DatabaseBackupSnapshotPort,
} from '../../../database/application/ports/database-backup-snapshot.port';
import { type TimezoneOptions } from '../../../config/application/ports/timezone-options.port';
import { ARCHIVE_ARTIFACT_REPOSITORY, type ArchiveArtifactRepositoryPort, type ArchiveSchedulerState } from '../ports/archive-artifact-repository.port';
import { ARCHIVE_REGISTRATION, type ArchiveRegistrationPort } from '../ports/archive-registration.port';
import { canonicalSourceFingerprintInput } from '../../domain/archive-artifact.entity';

const CATCHUP_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;

export interface CreateDatabaseBackupInput {
  nowMs: number;
  /** Set by the IANA-zone daily scheduler; boot calls the default catch-up path. */
  scheduled?: boolean;
}

export type CreateDatabaseBackupResult =
  | { created: true; reason: 'catchup' | 'scheduled' }
  | { created: false; reason: 'not_due' | 'lease_held' };

/** Creates a durable local SQLite snapshot, then atomically registers its immutable descriptor. */
@Injectable()
export class CreateDatabaseBackupUseCase {
  constructor(
    @Inject(DATABASE_BACKUP_SNAPSHOT) private readonly snapshots: DatabaseBackupSnapshotPort,
    @Inject(ARCHIVE_REGISTRATION) private readonly archive: ArchiveRegistrationPort,
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY) private readonly repository: ArchiveArtifactRepositoryPort,
    private readonly installationId: string | (() => string),
    private readonly timezone: TimezoneOptions,
  ) {}

  async execute(input: CreateDatabaseBackupInput): Promise<CreateDatabaseBackupResult> {
    const state = await this.repository.readSchedulerState();
    const reason = this.dueReason(state, input);
    if (!reason) return { created: false, reason: 'not_due' };
    if (state.backupLeaseOwner && state.backupLeaseExpiresAtMs !== null && state.backupLeaseExpiresAtMs > input.nowMs) {
      return { created: false, reason: 'lease_held' };
    }
    const owner = randomUUID();
    if (!(await this.repository.compareAndSetSchedulerState(state.revision, {
      backupLeaseOwner: owner,
      backupLeaseExpiresAtMs: input.nowMs + LEASE_MS,
    }))) return { created: false, reason: 'lease_held' };

    let succeeded = false;
    try {
      const snapshot = await this.snapshots.createOrLocateCompletedSnapshot(input.nowMs);
      const installationId = typeof this.installationId === 'function' ? this.installationId() : this.installationId;
      if (!installationId) throw new Error('Archive installation identity is unavailable');
      await this.archive.register({
        installationId,
        ...snapshot,
        sourceFingerprint: fingerprintForInstallation(installationId, snapshot),
      });
      const pinnedPaths = new Set(await this.repository.listUnverifiedArtifactPaths());
      await this.snapshots.pruneLocalSnapshots({ nowMs: input.nowMs, pinnedPaths, emergency: false });
      succeeded = true;
      return { created: true, reason };
    } finally {
      await this.releaseLease(owner, input.nowMs, succeeded);
    }
  }

  isCatchupDue(nowMs: number, lastBackupSuccessMs: number | null = null): boolean {
    return lastBackupSuccessMs === null || nowMs - lastBackupSuccessMs >= CATCHUP_MS;
  }

  isScheduledForNewLocalDay(nowMs: number, lastBackupSuccessMs: number | null): boolean {
    if (lastBackupSuccessMs === null) return true;
    return formatInTimeZone(nowMs, this.timezone.timezone, 'yyyy-MM-dd')
      !== formatInTimeZone(lastBackupSuccessMs, this.timezone.timezone, 'yyyy-MM-dd');
  }

  private dueReason(state: ArchiveSchedulerState, input: CreateDatabaseBackupInput): 'catchup' | 'scheduled' | null {
    if (this.isCatchupDue(input.nowMs, state.lastBackupSuccessMs)) return 'catchup';
    return input.scheduled && this.isScheduledForNewLocalDay(input.nowMs, state.lastBackupSuccessMs) ? 'scheduled' : null;
  }

  private async releaseLease(owner: string, nowMs: number, succeeded: boolean): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.repository.readSchedulerState();
      if (state.backupLeaseOwner !== owner) return;
      if (await this.repository.compareAndSetSchedulerState(state.revision, {
        backupLeaseOwner: null,
        backupLeaseExpiresAtMs: null,
        ...(succeeded ? { lastBackupSuccessMs: nowMs } : {}),
      })) return;
    }
  }
}

function fingerprintForInstallation(
  installationId: string,
  snapshot: import('../../../database/application/ports/database-backup-snapshot.port').DatabaseBackupDescriptor,
): string {
  return createHash('sha256').update(canonicalSourceFingerprintInput({
    installationId,
    kind: snapshot.kind,
    relativePath: snapshot.relativePath,
    size: snapshot.size,
    mtimeNs: snapshot.mtimeNs,
    sha256: snapshot.sha256,
  })).digest('hex');
}
