import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { encodeMotionFolderAppProperties } from '../../domain/app-properties';
import type { DriveConnection } from '../../domain/drive-connection.entity';
import type { DriveFolderReservation } from '../../domain/drive-folder-reservation.entity';
import { DriveFolderDiscoveryUncertainError } from '../../domain/errors/drive-folder-discovery-uncertain.error';
import type { ArchiveRemoteMutationLockService } from '../archive-remote-mutation-lock.service';
import {
  ARCHIVE_ADMIN_ALERT,
  type ArchiveAdminAlertPort,
} from '../ports/archive-admin-alert.port';
import {
  DRIVE_FOLDER,
  DriveFolderPageTokenRejectedError,
  type DriveFolderMetadata,
  type DriveFolderPort,
} from '../ports/drive-folder.port';
import {
  DRIVE_FOLDER_RESERVATION_REPOSITORY,
  type DriveFolderReservationRepositoryPort,
  type ReserveDriveFolder,
} from '../ports/drive-folder-reservation-repository.port';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const BLOCKED_ERROR_CODE = 'DRIVE_FOLDER_REVALIDATION_FAILED';
const CLAIM_DURATION_MS = 60_000;
const REVALIDATION_JITTER_MS = 1_000;
const REVALIDATION_SLOTS_MS = [
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;
const MAX_REVALIDATION_DELAY_MS = REVALIDATION_SLOTS_MS.at(-1)!;

export type RevalidateMotionArchiveBranchResult =
  | 'none'
  | 'restored'
  | 'adopted'
  | 'still-blocked';

export interface RevalidateMotionArchiveBranchOptions {
  random?: () => number;
  reservationId?: () => string;
  pageSize?: number;
  maxPages?: number;
}

@Injectable()
export class RevalidateMotionArchiveBranchUseCase {
  private readonly random: () => number;
  private readonly reservationId: () => string;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(
    @Inject(DRIVE_FOLDER)
    private readonly drive: DriveFolderPort,
    @Inject(DRIVE_FOLDER_RESERVATION_REPOSITORY)
    private readonly repository: DriveFolderReservationRepositoryPort,
    private readonly lock: Pick<ArchiveRemoteMutationLockService, 'runExclusive'>,
    @Inject(ARCHIVE_ADMIN_ALERT)
    private readonly alerts: ArchiveAdminAlertPort,
    options: RevalidateMotionArchiveBranchOptions = {},
  ) {
    this.random = options.random ?? Math.random;
    this.reservationId = options.reservationId ?? randomUUID;
    this.pageSize = positiveInteger(options.pageSize ?? 100, 'page size');
    this.maxPages = positiveInteger(options.maxPages ?? 20, 'page limit');
  }

  async executeNext(
    connection: DriveConnection,
    nowMs: number,
    signal: AbortSignal,
  ): Promise<RevalidateMotionArchiveBranchResult> {
    throwIfAborted(signal);
    if (!isActive(connection)) return 'none';
    return this.lock.runExclusive(async () => {
      throwIfAborted(signal);
      const claimed = await this.repository.claimNextBlockedRevalidation({
        generationId: connection.id,
        nowMs,
        claimUntilMs: nowMs + CLAIM_DURATION_MS,
      });
      if (claimed === null) return 'none';
      throwIfAborted(signal);
      try {
        return claimed.state === 'detached'
          ? await this.revalidateDetached(connection, claimed, nowMs, signal)
          : await this.revalidateConflict(connection, claimed, nowMs, signal);
      } catch (error) {
        throwIfAborted(signal);
        await this.keepBlocked(claimed, nowMs);
        throw error;
      }
    });
  }

  private async revalidateDetached(
    connection: DriveConnection,
    claimed: DriveFolderReservation,
    nowMs: number,
    signal: AbortSignal,
  ): Promise<RevalidateMotionArchiveBranchResult> {
    throwIfAborted(signal);
    const exact = await this.drive.loadExact(connection, claimed.folderId, signal);
    throwIfAborted(signal);
    if (exact === null || !isExactFolder(exact, connection, claimed)) {
      await this.keepBlocked(claimed, nowMs);
      return 'still-blocked';
    }
    const restored = await this.repository.restoreDetached(
      claimed.id,
      claimed.revision,
      nowMs,
    );
    return restored === null ? 'still-blocked' : 'restored';
  }

  private async revalidateConflict(
    connection: DriveConnection,
    claimed: DriveFolderReservation,
    nowMs: number,
    signal: AbortSignal,
  ): Promise<RevalidateMotionArchiveBranchResult> {
    const identities = await this.listIdentityCandidates(connection, claimed, signal);
    throwIfAborted(signal);
    const live = identities.filter((candidate) => candidate.trashed !== true);
    if (live.length !== 1 || !isExactFolder(live[0], connection, claimed)) {
      await this.keepBlocked(claimed, nowMs);
      return 'still-blocked';
    }
    const adopted = await this.repository.adoptConflictCandidate({
      expected: { id: claimed.id, revision: claimed.revision },
      replacement: replacementFor(claimed, this.reservationId(), live[0].id),
      nowMs,
    });
    if (adopted.kind === 'stored') return 'adopted';
    await this.keepBlocked(claimed, nowMs);
    return 'still-blocked';
  }

  private async listIdentityCandidates(
    connection: DriveConnection,
    claimed: DriveFolderReservation,
    signal: AbortSignal,
  ): Promise<readonly DriveFolderMetadata[]> {
    let restarted = false;
    for (;;) {
      const candidates = new Map<string, DriveFolderMetadata>();
      let pageToken: string | null = null;
      let restart = false;
      for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
        throwIfAborted(signal);
        let page;
        try {
          page = await this.drive.listCandidates({
            connection,
            scope: 'identity',
            parentId: null,
            role: roleFor(claimed),
            normalizedPath: claimed.normalizedPath,
            pageToken,
            pageSize: this.pageSize,
          }, signal);
        } catch (error) {
          if (!restarted && isRejectedPageToken(error)) {
            restarted = true;
            restart = true;
            break;
          }
          if (isRejectedPageToken(error)) throw new DriveFolderDiscoveryUncertainError();
          throw error;
        }
        throwIfAborted(signal);
        if (page.incompleteSearch) throw new DriveFolderDiscoveryUncertainError();
        for (const candidate of page.folders) candidates.set(candidate.id, candidate);
        pageToken = page.nextPageToken;
        if (pageToken === null) return [...candidates.values()];
      }
      if (restart) continue;
      throw new DriveFolderDiscoveryUncertainError();
    }
  }

  private async keepBlocked(
    claimed: DriveFolderReservation,
    nowMs: number,
  ): Promise<void> {
    const rescheduled = await this.repository.rescheduleBlockedRevalidation({
      id: claimed.id,
      expectedRevision: claimed.revision,
      errorCode: BLOCKED_ERROR_CODE,
      nowMs,
      nextRevalidationAtMs: nextRevalidationDeadline(
        nowMs,
        claimed.revalidationFailureStreak,
        this.random,
      ),
    });
    if (rescheduled === null) return;
    await this.alerts.alert('folder-branch-unhealthy', {
      generationId: claimed.generationId,
      errorCode: BLOCKED_ERROR_CODE,
    }).catch(() => undefined);
  }
}

function replacementFor(
  claimed: DriveFolderReservation,
  id: string,
  folderId: string,
): ReserveDriveFolder {
  return {
    id,
    installationId: claimed.installationId,
    generationId: claimed.generationId,
    normalizedPath: claimed.normalizedPath,
    level: claimed.level,
    segmentName: claimed.segmentName,
    folderId,
    parentFolderId: claimed.parentFolderId,
  };
}

function isActive(connection: DriveConnection): boolean {
  return connection.status === 'active'
    && connection.permissionId !== null
    && connection.folders !== null;
}

function isExactFolder(
  folder: DriveFolderMetadata,
  connection: DriveConnection,
  reservation: DriveFolderReservation,
): boolean {
  if (connection.permissionId === null) return false;
  const expectedProperties = encodeMotionFolderAppProperties({
    installationId: connection.installationId,
    generationId: connection.id,
    role: roleFor(reservation),
    normalizedPath: reservation.normalizedPath,
    schemaVersion: 1,
  });
  const matchesIdentity = reservation.state === 'conflict'
    || folder.id === reservation.folderId;
  return matchesIdentity
    && folder.name === reservation.segmentName
    && folder.mimeType === FOLDER_MIME_TYPE
    && sameExactValues(folder.parentIds, [reservation.parentFolderId])
    && sameProperties(folder.appProperties, expectedProperties)
    && folder.ownedByMe === true
    && sameExactValues(folder.ownerPermissionIds, [connection.permissionId])
    && sameExactValues(folder.permissionIds, [connection.permissionId])
    && folder.shared === false
    && folder.trashed === false;
}

function roleFor(
  reservation: Pick<DriveFolderReservation, 'level'>,
): 'motion-year' | 'motion-month' | 'motion-day' {
  if (reservation.level === 'year') return 'motion-year';
  if (reservation.level === 'month') return 'motion-month';
  return 'motion-day';
}

function sameExactValues(
  actual: readonly string[] | null,
  expected: readonly string[],
): boolean {
  return actual !== null
    && actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

function sameProperties(
  actual: Readonly<Record<string, string>> | null,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (actual === null) return false;
  const entries = Object.entries(expected);
  return Object.keys(actual).length === entries.length
    && entries.every(([key, value]) => actual[key] === value);
}

function nextRevalidationDeadline(
  nowMs: number,
  failureStreak: number,
  random: () => number,
): number {
  const slot = REVALIDATION_SLOTS_MS[
    Math.min(failureStreak, REVALIDATION_SLOTS_MS.length - 1)
  ];
  const sample = random();
  const normalized = Number.isFinite(sample)
    ? Math.max(0, Math.min(sample, 0.999999999))
    : 0;
  const jitterMs = Math.floor(normalized * REVALIDATION_JITTER_MS);
  const delay = slot === MAX_REVALIDATION_DELAY_MS
    ? slot - jitterMs
    : slot + jitterMs;
  return nowMs + delay;
}

function isRejectedPageToken(error: unknown): boolean {
  return error instanceof DriveFolderPageTokenRejectedError
    || (typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'DRIVE_FOLDER_PAGE_TOKEN_REJECTED');
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Drive folder revalidation ${label} is invalid`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}
