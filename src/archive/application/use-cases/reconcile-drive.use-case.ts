import { Inject, Injectable } from '@nestjs/common';
import type { DriveConnection } from '../../domain/drive-connection.entity';
import type { VerifiedDriveObject } from '../../domain/drive-object-metadata.value-object';
import {
  classifyRemoteObject,
  hasUnchangedTrustedSource,
  isAdoptableRemoteObject,
  parentFor,
  toArchiveObject,
} from '../archive-object-verification';
import {
  ARCHIVE_ARTIFACT_REPOSITORY,
  type ArchiveArtifactRepositoryPort,
  type ArchiveObjectAttempt,
} from '../ports/archive-artifact-repository.port';
import { DRIVE_ARCHIVE, type DriveArchivePort } from '../ports/drive-archive.port';
import {
  DRIVE_CREDENTIAL_REPOSITORY,
  type DriveCredentialRepositoryPort,
} from '../ports/drive-credential-repository.port';
import {
  ARCHIVE_UPLOAD_SOURCE,
  type ArchiveUploadSourcePort,
} from './upload-drive-object-attempt.use-case';
import type { ArchiveRemoteMutationLockService } from '../archive-remote-mutation-lock.service';
import { DriveObjectConflictError } from '../../domain/errors/drive-object-conflict.error';
import type { ArchiveAdminAlertPort } from '../ports/archive-admin-alert.port';

export interface ReconcileDriveOptions {
  now?: () => number;
  pageSize?: number;
  maxPages?: number;
}

export interface ReconcileDriveResult {
  checked: number;
  missing: number;
  detached: number;
  renamed: number;
  adopted: number;
}

/** Revalidates immutable attempts by exact ID and discovers restored manifests. */
@Injectable()
export class ReconcileDriveUseCase {
  private readonly now: () => number;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(
    @Inject(ARCHIVE_ARTIFACT_REPOSITORY)
    private readonly repository: ArchiveArtifactRepositoryPort,
    @Inject(DRIVE_CREDENTIAL_REPOSITORY)
    private readonly credentials: Pick<DriveCredentialRepositoryPort, 'loadActive'>,
    @Inject(DRIVE_ARCHIVE)
    private readonly drive: DriveArchivePort,
    @Inject(ARCHIVE_UPLOAD_SOURCE)
    private readonly source: ArchiveUploadSourcePort,
    private readonly alerts: ArchiveAdminAlertPort,
    options: ReconcileDriveOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.pageSize = positive(options.pageSize ?? 100, 'page size');
    this.maxPages = positive(options.maxPages ?? 20, 'page limit');
  }

  async execute(
    input: { limit: number },
    signal: AbortSignal,
    lock?: Pick<ArchiveRemoteMutationLockService, 'runExclusive' | 'runActivity'>,
  ): Promise<ReconcileDriveResult> {
    if (lock !== undefined) {
      return lock.runActivity(() => this.executeActive(input, signal, lock));
    }
    return this.executeActive(input, signal, lock);
  }

  private async executeActive(
    input: { limit: number },
    signal: AbortSignal,
    lock: Pick<ArchiveRemoteMutationLockService, 'runExclusive'> | undefined,
  ): Promise<ReconcileDriveResult> {
    const limit = positive(input.limit, 'batch limit');
    throwIfAborted(signal);
    const active = await this.credentials.loadActive();
    if (active?.status !== 'active' || active.folders === null) return emptyResult();
    const result = emptyResult();
    const attempts = await this.repository.listReconciliationBatch({
      limit,
      generationId: active.id,
    });
    for (const attempt of attempts) {
      throwIfAborted(signal);
      await this.reconcileAttempt(attempt, active, result, signal, lock);
    }
    throwIfAborted(signal);
    result.adopted = await this.restoreManagedObjects(active, limit, signal, lock);
    return result;
  }

  private async reconcileAttempt(
    attempt: ArchiveObjectAttempt,
    active: DriveConnection,
    result: ReconcileDriveResult,
    signal: AbortSignal,
    lock?: Pick<ArchiveRemoteMutationLockService, 'runExclusive'>,
  ): Promise<void> {
    const artifact = await this.repository.loadArtifact(attempt.artifactId);
    if (artifact?.currentVerifiedAttemptId !== attempt.id) return;
    const remote = await this.drive.loadObject(active, attempt.remoteObjectId, signal);
    result.checked += 1;
    const classification = classifyRemoteObject(artifact, attempt, active, remote);
    if (classification === 'exact') {
      await exclusive(lock, () => this.repository.markReconciled(
        attempt.id,
        attempt.revision,
        this.now(),
      ));
      return;
    }
    if (classification === 'rename' && remote !== null) {
      await exclusive(lock, () => this.repository.acceptReconciledRename(
        attempt.id, attempt.revision, remote.name, remote.version, this.now(),
      ));
      result.renamed += 1;
      return;
    }
    if (classification === 'missing') {
      const trusted = await hasUnchangedTrustedSource(artifact, this.source, signal);
      const replacementId = trusted
        ? await this.drive.generateFileId(active, signal)
        : null;
      if (replacementId !== null) {
        await exclusive(lock, () => this.repository.replaceMissingWithReservedAttempt(
          attempt.id,
          attempt.revision,
          remote?.trashed ? 'remote_trashed' : 'remote_missing',
          replacementId,
          parentFor(artifact, active),
          this.now(),
        ));
      } else {
        await this.alerts.alert({
          artifactId: artifact.id,
          reason: 'remote_missing_without_local_source',
        });
        await exclusive(lock, () => this.repository.markMissing(
          attempt.id,
          attempt.revision,
          remote?.trashed ? 'remote_trashed' : 'remote_missing',
          this.now(),
        ));
      }
      result.missing += 1;
      return;
    }
    await this.alerts.alert({ artifactId: artifact.id, reason: 'remote_detached' });
    await exclusive(lock, () => this.repository.markDetached(
      attempt.id, attempt.revision, 'remote_metadata_changed', this.now(),
    ));
    result.detached += 1;
  }

  private async restoreManagedObjects(
    active: DriveConnection,
    limit: number,
    signal: AbortSignal,
    lock?: Pick<ArchiveRemoteMutationLockService, 'runExclusive'>,
  ): Promise<number> {
    const artifacts = await this.repository.listRestorationCandidates(limit);
    if (artifacts.length === 0) return 0;
    const objects = await this.listBounded(active, signal);
    if (objects === null) return 0;
    let adopted = 0;
    for (const artifact of artifacts) {
      throwIfAborted(signal);
      const attempts = await this.repository.listAttempts(artifact.id);
      const historicalIds = new Set(
        attempts
          .filter((attempt) => !['pending', 'retryable', 'uploading'].includes(attempt.state))
          .map((attempt) => attempt.remoteObjectId),
      );
      const liveReservedIds = new Set(
        attempts
          .filter((attempt) => ['pending', 'retryable', 'uploading'].includes(attempt.state))
          .map((attempt) => attempt.remoteObjectId),
      );
      const matches = objects.filter((remote) =>
        !historicalIds.has(remote.id)
          && (liveReservedIds.size === 0 || liveReservedIds.has(remote.id))
          && isAdoptableRemoteObject(artifact, active, remote),
      );
      if (matches.length !== 1) continue;
      try {
        await exclusive(lock, () => this.repository.adoptVerifiedObject(
          artifact.id, active.id, toArchiveObject(matches[0]), this.now(),
        ));
        adopted += 1;
      } catch (error) {
        if (!(error instanceof DriveObjectConflictError)) throw error;
      }
    }
    return adopted;
  }

  private async listBounded(
    active: DriveConnection,
    signal: AbortSignal,
  ): Promise<readonly VerifiedDriveObject[] | null> {
    const objects: VerifiedDriveObject[] = [];
    for (const parentId of [active.folders!.motionId, active.folders!.backupsId]) {
      let pageToken: string | null = null;
      for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
        throwIfAborted(signal);
        const page = await this.drive.listManagedObjects({
          connection: active,
          parentId,
          pageToken,
          pageSize: this.pageSize,
        }, signal);
        if (page.incompleteSearch) return null;
        objects.push(...page.objects);
        pageToken = page.nextPageToken;
        if (pageToken === null) break;
        if (pageNumber === this.maxPages - 1) return null;
      }
    }
    return objects;
  }

}

function emptyResult(): ReconcileDriveResult {
  return { checked: 0, missing: 0, detached: 0, renamed: 0, adopted: 0 };
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Archive reconciliation ${label} is invalid`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
}

function exclusive<T>(
  lock: Pick<ArchiveRemoteMutationLockService, 'runExclusive'> | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return lock === undefined ? operation() : lock.runExclusive(operation);
}
