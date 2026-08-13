import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { encodeMotionFolderAppProperties } from '../../domain/app-properties';
import type { DriveConnection } from '../../domain/drive-connection.entity';
import type { DriveFolderReservation } from '../../domain/drive-folder-reservation.entity';
import { DriveFolderBranchBlockedError } from '../../domain/errors/drive-folder-branch-blocked.error';
import type { MotionArchivePath } from '../../domain/motion-archive-path.value-object';
import type { ArchiveRemoteMutationLockService } from '../archive-remote-mutation-lock.service';
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
const BLOCKED_CODE = 'DRIVE_FOLDER_BRANCH_BLOCKED';
const MAX_BLOCK_CAS_RELOADS = 3;

type DateFolderLevel = Readonly<{
  level: 'year' | 'month' | 'day';
  role: 'motion-year' | 'motion-month' | 'motion-day';
  normalizedPath: string;
  segmentName: string;
}>;

export interface ResolveMotionArchiveContainerOptions {
  now?: () => number;
  reservationId?: () => string;
  pageSize?: number;
  maxPages?: number;
}

/** Resolves one durable, exact-ID year/month/day branch below managed Motion. */
@Injectable()
export class ResolveMotionArchiveContainerUseCase {
  private readonly now: () => number;
  private readonly reservationId: () => string;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(
    @Inject(DRIVE_FOLDER)
    private readonly drive: DriveFolderPort,
    @Inject(DRIVE_FOLDER_RESERVATION_REPOSITORY)
    private readonly reservations: DriveFolderReservationRepositoryPort,
    private readonly remoteMutationLock: Pick<ArchiveRemoteMutationLockService, 'runExclusive'>,
    options: ResolveMotionArchiveContainerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.reservationId = options.reservationId ?? randomUUID;
    this.pageSize = positiveInteger(options.pageSize ?? 100, 'page size');
    this.maxPages = positiveInteger(options.maxPages ?? 20, 'page limit');
  }

  async execute(
    connection: DriveConnection,
    path: MotionArchivePath,
    signal: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    return this.remoteMutationLock.runExclusive(async () => {
      throwIfAborted(signal);
      if (connection.status !== 'active' || connection.folders === null || connection.permissionId === null) {
        throw blocked();
      }
      const levels = [
        { level: 'year', role: 'motion-year', normalizedPath: path.yearPath, segmentName: path.year },
        { level: 'month', role: 'motion-month', normalizedPath: path.monthPath, segmentName: path.month },
        { level: 'day', role: 'motion-day', normalizedPath: path.dayPath, segmentName: path.day },
      ] as const;
      let parentId = connection.folders.motionId;
      for (const level of levels) {
        parentId = await this.resolveLevel(connection, level, parentId, signal);
      }
      return parentId;
    });
  }

  private async resolveLevel(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    signal: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const current = await this.reservations.loadCurrent(connection.id, level.normalizedPath);
    if (current !== null) return this.resolveCurrent(connection, level, parentId, current, signal);

    const discovery = await this.listCandidates(connection, level, parentId, signal);
    if (discovery.kind === 'conflict') {
      return this.persistConflict(connection, level, parentId, signal);
    }
    if (discovery.folders.length === 1) {
      return this.adoptCandidate(connection, level, parentId, discovery.folders[0], signal);
    }
    return this.reserveAndCreate(connection, level, parentId, null, signal);
  }

  private async resolveCurrent(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    current: DriveFolderReservation,
    signal: AbortSignal,
    blockCasReloads = MAX_BLOCK_CAS_RELOADS,
  ): Promise<string> {
    if (current.state === 'detached' || current.state === 'conflict') throw blocked();
    if (!matchesReservation(current, level, parentId)) {
      return this.blockAndResolve(
        connection, level, parentId, current, 'conflict', signal, blockCasReloads,
      );
    }
    throwIfAborted(signal);
    const exact = await this.drive.loadExact(connection, current.folderId, signal);
    if (exact === null || exact.trashed === true) {
      return this.replaceMissing(connection, level, parentId, current, signal);
    }
    if (!isExactFolder(exact, connection, level, parentId, current.folderId)) {
      return this.blockAndResolve(
        connection, level, parentId, current, 'detached', signal, blockCasReloads,
      );
    }
    return this.verifyReservation(connection, level, parentId, current, signal);
  }

  private async replaceMissing(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    current: DriveFolderReservation,
    signal: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const folderId = await this.drive.generateId(connection, signal);
    const result = await this.reservations.replaceMissing({
      expected: { id: current.id, revision: current.revision, folderId: current.folderId },
      replacement: this.replacement(connection, level, parentId, folderId),
      nowMs: this.now(),
    });
    if (result.kind === 'lost') {
      return this.resolveWinner(connection, level, parentId, result.current, signal);
    }
    return this.createReserved(connection, level, parentId, result.reservation, signal);
  }

  private async adoptCandidate(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    candidate: DriveFolderMetadata,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await this.reservations.compareAndSetCurrent({
      expected: null,
      replacement: this.replacement(connection, level, parentId, candidate.id),
      nowMs: this.now(),
    });
    if (result.kind === 'lost') {
      return this.resolveWinner(connection, level, parentId, result.current, signal);
    }
    throwIfAborted(signal);
    const exact = await this.drive.loadExact(connection, candidate.id, signal);
    if (exact === null || exact.trashed === true) {
      return this.replaceMissing(connection, level, parentId, result.reservation, signal);
    }
    if (!isExactFolder(exact, connection, level, parentId, candidate.id)) {
      return this.blockAndResolve(
        connection, level, parentId, result.reservation, 'detached', signal,
      );
    }
    return this.verifyReservation(connection, level, parentId, result.reservation, signal);
  }

  private async reserveAndCreate(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    expected: { id: string; revision: number } | null,
    signal: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const folderId = await this.drive.generateId(connection, signal);
    const result = await this.reservations.compareAndSetCurrent({
      expected,
      replacement: this.replacement(connection, level, parentId, folderId),
      nowMs: this.now(),
    });
    if (result.kind === 'lost') {
      return this.resolveWinner(connection, level, parentId, result.current, signal);
    }
    return this.createReserved(connection, level, parentId, result.reservation, signal);
  }

  private async createReserved(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    reservation: DriveFolderReservation,
    signal: AbortSignal,
  ): Promise<string> {
    const appProperties = propertiesFor(connection, level);
    let exact: DriveFolderMetadata;
    try {
      throwIfAborted(signal);
      exact = await this.drive.create({
        connection,
        id: reservation.folderId,
        parentId,
        name: level.segmentName,
        appProperties,
      }, signal);
    } catch (error) {
      throwIfAborted(signal);
      const recovered = await this.drive.loadExact(connection, reservation.folderId, signal);
      if (recovered === null || !isExactFolder(recovered, connection, level, parentId, reservation.folderId)) {
        throw error;
      }
      exact = recovered;
    }
    if (!isExactFolder(exact, connection, level, parentId, reservation.folderId)) {
      return this.blockAndResolve(
        connection, level, parentId, reservation, 'conflict', signal,
      );
    }
    return this.verifyReservation(connection, level, parentId, reservation, signal);
  }

  private async verifyReservation(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    reservation: DriveFolderReservation,
    signal: AbortSignal,
  ): Promise<string> {
    const verified = await this.reservations.markVerified(
      reservation.id,
      reservation.revision,
      this.now(),
    );
    if (verified !== null) return reservation.folderId;
    const winner = await this.reservations.loadCurrent(connection.id, level.normalizedPath);
    return this.resolveWinner(connection, level, parentId, winner, signal);
  }

  private async resolveWinner(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    winner: DriveFolderReservation | null,
    signal: AbortSignal,
  ): Promise<string> {
    if (winner === null) throw blocked();
    return this.resolveCurrent(connection, level, parentId, winner, signal);
  }

  private async persistConflict(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    signal: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const markerId = await this.drive.generateId(connection, signal);
    const result = await this.reservations.compareAndSetCurrent({
      expected: null,
      replacement: this.replacement(connection, level, parentId, markerId),
      nowMs: this.now(),
    });
    if (result.kind === 'lost') {
      return this.resolveWinner(connection, level, parentId, result.current, signal);
    }
    return this.blockConflictMarker(
      connection, level, parentId, result.reservation, signal, MAX_BLOCK_CAS_RELOADS,
    );
  }

  private async blockAndResolve(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    reservation: DriveFolderReservation,
    state: 'detached' | 'conflict',
    signal: AbortSignal,
    remainingReloads = MAX_BLOCK_CAS_RELOADS,
  ): Promise<string> {
    const marked = await this.reservations.markBlocked(
      reservation.id,
      reservation.revision,
      state,
      BLOCKED_CODE,
      this.now(),
    );
    if (marked !== null) throw blocked();
    if (remainingReloads < 1) throw blocked();
    const winner = await this.reservations.loadCurrent(
      connection.id,
      level.normalizedPath,
    );
    if (winner === null) throw blocked();
    return this.resolveCurrent(
      connection,
      level,
      parentId,
      winner,
      signal,
      remainingReloads - 1,
    );
  }

  private async blockConflictMarker(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    marker: DriveFolderReservation,
    signal: AbortSignal,
    remainingReloads: number,
  ): Promise<string> {
    const marked = await this.reservations.markBlocked(
      marker.id,
      marker.revision,
      'conflict',
      BLOCKED_CODE,
      this.now(),
    );
    if (marked !== null) throw blocked();
    if (remainingReloads < 1) throw blocked();
    const winner = await this.reservations.loadCurrent(
      connection.id,
      level.normalizedPath,
    );
    if (winner === null) throw blocked();
    if (winner.id !== marker.id) {
      return this.resolveWinner(connection, level, parentId, winner, signal);
    }
    if (winner.state === 'detached' || winner.state === 'conflict') throw blocked();
    return this.blockConflictMarker(
      connection,
      level,
      parentId,
      winner,
      signal,
      remainingReloads - 1,
    );
  }

  private replacement(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    folderId: string,
  ): ReserveDriveFolder {
    return {
      id: this.reservationId(),
      installationId: connection.installationId,
      generationId: connection.id,
      normalizedPath: level.normalizedPath,
      level: level.level,
      segmentName: level.segmentName,
      folderId,
      parentFolderId: parentId,
    };
  }

  private async listCandidates(
    connection: DriveConnection,
    level: DateFolderLevel,
    parentId: string,
    signal: AbortSignal,
  ): Promise<
    | { kind: 'complete'; folders: readonly DriveFolderMetadata[] }
    | { kind: 'conflict' }
  > {
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
            parentId,
            role: level.role,
            normalizedPath: level.normalizedPath,
            pageToken,
            pageSize: this.pageSize,
          }, signal);
        } catch (error) {
          if (!restarted && isRejectedPageToken(error)) {
            restarted = true;
            restart = true;
            break;
          }
          throw error;
        }
        if (page.incompleteSearch) return { kind: 'conflict' };
        for (const folder of page.folders) {
          if (isExactFolder(folder, connection, level, parentId, folder.id)) {
            candidates.set(folder.id, folder);
          }
        }
        if (candidates.size > 1) return { kind: 'conflict' };
        pageToken = page.nextPageToken;
        if (pageToken === null) {
          return { kind: 'complete', folders: [...candidates.values()] };
        }
      }
      if (restart) continue;
      return { kind: 'conflict' };
    }
  }
}

function propertiesFor(connection: DriveConnection, level: DateFolderLevel) {
  return encodeMotionFolderAppProperties({
    installationId: connection.installationId,
    generationId: connection.id,
    role: level.role,
    normalizedPath: level.normalizedPath,
    schemaVersion: 1,
  });
}

function matchesReservation(
  reservation: DriveFolderReservation,
  level: DateFolderLevel,
  parentId: string,
): boolean {
  return reservation.normalizedPath === level.normalizedPath
    && reservation.level === level.level
    && reservation.segmentName === level.segmentName
    && reservation.parentFolderId === parentId;
}

function isExactFolder(
  folder: DriveFolderMetadata,
  connection: DriveConnection,
  level: DateFolderLevel,
  parentId: string,
  folderId: string,
): boolean {
  const permissionId = connection.permissionId;
  if (permissionId === null) return false;
  const expectedProperties = propertiesFor(connection, level);
  return folder.id === folderId
    && folder.name === level.segmentName
    && folder.mimeType === FOLDER_MIME_TYPE
    && sameExactValues(folder.parentIds, [parentId])
    && sameProperties(folder.appProperties, expectedProperties)
    && folder.ownedByMe === true
    && sameExactValues(folder.ownerPermissionIds, [permissionId])
    && sameExactValues(folder.permissionIds, [permissionId])
    && folder.shared === false
    && folder.trashed === false;
}

function sameExactValues(actual: readonly string[] | null, expected: readonly string[]): boolean {
  return actual !== null
    && actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

function sameProperties(
  actual: Readonly<Record<string, string>> | null,
  expected: Readonly<Record<string, string>>,
): boolean {
  if (actual === null) return false;
  const expectedEntries = Object.entries(expected);
  return Object.keys(actual).length === expectedEntries.length
    && expectedEntries.every(([key, value]) => actual[key] === value);
}

function isRejectedPageToken(error: unknown): boolean {
  return error instanceof DriveFolderPageTokenRejectedError
    || (typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'DRIVE_FOLDER_PAGE_TOKEN_REJECTED');
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Drive motion folder ${label} is invalid`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

function blocked(): DriveFolderBranchBlockedError {
  return new DriveFolderBranchBlockedError();
}
