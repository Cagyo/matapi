import { describe, expect, it, vi } from 'vitest';
import { ArchiveRemoteMutationLockService } from '../../../src/archive/application/archive-remote-mutation-lock.service';
import type { ArchiveAdminAlertPort } from '../../../src/archive/application/ports/archive-admin-alert.port';
import {
  DriveFolderPageTokenRejectedError,
  type DriveFolderCreateInput,
  type DriveFolderListInput,
  type DriveFolderMetadata,
  type DriveFolderPage,
  type DriveFolderPort,
} from '../../../src/archive/application/ports/drive-folder.port';
import { RevalidateMotionArchiveBranchUseCase } from '../../../src/archive/application/use-cases/revalidate-motion-archive-branch.use-case';
import { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import type { DriveFolderReservation } from '../../../src/archive/domain/drive-folder-reservation.entity';
import { DriveFolderDiscoveryUncertainError } from '../../../src/archive/domain/errors/drive-folder-discovery-uncertain.error';
import { DriveTemporaryUnavailableError } from '../../../src/archive/domain/errors/drive-temporary-unavailable.error';
import { InMemoryDriveFolderReservationRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-folder-reservation.repository';

const NOW_MS = 900_000;

describe('RevalidateMotionArchiveBranchUseCase', () => {
  it('restores one detached head after one exact read proves every invariant', async () => {
    const fixture = await detachedFixture();
    fixture.drive.exact.set('detached-id', exactDayFolder());

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .resolves.toBe('restored');

    expect(fixture.drive.loadExact).toHaveBeenCalledTimes(1);
    expect(fixture.drive.listCandidates).not.toHaveBeenCalled();
    expect(fixture.drive.generateId).not.toHaveBeenCalled();
    expect(fixture.drive.create).not.toHaveBeenCalled();
    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({
        state: 'verified', folderId: 'detached-id',
        errorCode: null, revalidationFailureStreak: 0,
        nextRevalidationAtMs: null, verifiedAtMs: NOW_MS,
      });
  });

  it.each([
    ['returned ID', { id: 'another-id' }],
    ['visible name', { name: 'renamed-day' }],
    ['MIME type', { mimeType: 'text/plain' }],
    ['exact parent', { parentIds: ['another-month'] }],
    ['private app properties', { appProperties: { ...dayProperties(), a1p: '2026/08/14' } }],
    ['My Drive ownership', { ownedByMe: false }],
    ['owner permission identity', { ownerPermissionIds: ['another-owner'] }],
    ['private permission set', { permissionIds: ['owner-1', 'reader-1'] }],
    ['private sharing', { shared: true }],
    ['non-trashed state', { trashed: true }],
  ] satisfies readonly (readonly [string, Partial<DriveFolderMetadata>])[])(
    'keeps a detached head blocked when its %s invariant is not restored',
    async (_label, changed) => {
      const fixture = await detachedFixture({ random: () => 0 });
      fixture.drive.exact.set('detached-id', exactDayFolder(changed));

      await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
        .resolves.toBe('still-blocked');

      expect(fixture.drive.loadExact).toHaveBeenCalledTimes(1);
      expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
        .toMatchObject({
          state: 'detached', revalidationFailureStreak: 2,
          nextRevalidationAtMs: NOW_MS + 30 * 60_000,
        });
    },
  );

  it('reschedules a missing detached probe with fresh bounded backoff and no provider storm', async () => {
    const fixture = await detachedFixture({ random: () => 0.5 });
    fixture.drive.exact.set('detached-id', null);

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .resolves.toBe('still-blocked');

    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({
        state: 'detached', revalidationFailureStreak: 2,
        nextRevalidationAtMs: NOW_MS + 30 * 60_000 + 500,
      });
    expect(fixture.drive.loadExact).toHaveBeenCalledTimes(1);
    expect(fixture.drive.listCandidates).not.toHaveBeenCalled();
    expect(fixture.alerts.alert).toHaveBeenCalledOnce();
    expect(fixture.alerts.alert).toHaveBeenCalledWith('folder-branch-unhealthy', {
      generationId: 'generation-1',
      errorCode: 'DRIVE_FOLDER_REVALIDATION_FAILED',
    });
    expect(JSON.stringify(fixture.alerts.alert.mock.calls)).not.toContain('detached-id');
    expect(JSON.stringify(fixture.alerts.alert.mock.calls)).not.toContain('2026/08/13');
  });

  it('samples fresh jitter at the six-hour slot without exceeding its cap', async () => {
    const random = vi.fn()
      .mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0.75);
    const fixture = await detachedFixture({ random });
    let current = await fixture.repository.loadCurrent(connection.id, '2026/08/13');
    if (current === null) throw new Error('expected detached fixture head');
    for (let streak = current.revalidationFailureStreak; streak < 8; streak += 1) {
      const rescheduled = await fixture.repository.rescheduleBlockedRevalidation({
        id: current.id,
        expectedRevision: current.revision,
        errorCode: 'seeded_failure',
        nowMs: NOW_MS - 1,
        nextRevalidationAtMs: NOW_MS,
      });
      if (rescheduled === null) throw new Error('expected seeded revalidation failure');
      current = rescheduled;
    }

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .resolves.toBe('still-blocked');
    const first = await fixture.repository.loadCurrent(connection.id, '2026/08/13');
    const firstDeadlineMs = first?.nextRevalidationAtMs ?? null;
    if (firstDeadlineMs === null) {
      throw new Error('expected first capped revalidation deadline');
    }
    expect(firstDeadlineMs - NOW_MS)
      .toBe(6 * 60 * 60_000 - 250);

    await expect(fixture.useCase.executeNext(
      connection,
      firstDeadlineMs,
      signal(),
    )).resolves.toBe('still-blocked');
    const second = await fixture.repository.loadCurrent(connection.id, '2026/08/13');
    const secondDeadlineMs = second?.nextRevalidationAtMs ?? null;
    if (secondDeadlineMs === null) {
      throw new Error('expected second capped revalidation deadline');
    }
    expect(secondDeadlineMs - firstDeadlineMs)
      .toBe(6 * 60 * 60_000 - 750);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it('adopts one remaining conflict candidate after one identity-only traversal', async () => {
    const fixture = await conflictFixture();
    fixture.drive.identitySteps.push(page(exactDayFolder({ id: 'survivor-id' })));

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .resolves.toBe('adopted');

    expect(fixture.drive.listCandidates).toHaveBeenCalledTimes(1);
    expect(fixture.drive.listCandidates.mock.calls[0]?.[0]).toMatchObject({
      scope: 'identity', parentId: null, role: 'motion-day',
      normalizedPath: '2026/08/13', pageToken: null,
    });
    expect(fixture.drive.loadExact).not.toHaveBeenCalled();
    expect(fixture.drive.generateId).not.toHaveBeenCalled();
    expect(fixture.drive.create).not.toHaveBeenCalled();
    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({ state: 'verified', folderId: 'survivor-id' });
  });

  it('keeps a conflict blocked when more than one live identity remains', async () => {
    const fixture = await conflictFixture({ random: () => 0 });
    fixture.drive.identitySteps.push({
      folders: [
        exactDayFolder({ id: 'survivor-id' }),
        exactDayFolder({ id: 'duplicate-id' }),
      ],
      nextPageToken: null,
      incompleteSearch: false,
    });

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .resolves.toBe('still-blocked');

    expect(fixture.drive.listCandidates).toHaveBeenCalledTimes(1);
    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({ state: 'conflict', revalidationFailureStreak: 2 });
  });

  it('reschedules a conflict adoption rejected by historical folder identity', async () => {
    const fixture = await conflictFixture({ random: () => 0.5 });
    await fixture.repository.appendMissingIdentity({
      reservation: {
        id: 'historical-reservation',
        installationId: 'installation-1',
        generationId: 'generation-1',
        normalizedPath: '2026/08/12',
        level: 'day',
        segmentName: '12',
        folderId: 'survivor-id',
        parentFolderId: 'existing-month',
      },
      nowMs: 100,
    });
    fixture.drive.identitySteps.push(page(exactDayFolder({ id: 'survivor-id' })));

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .resolves.toBe('still-blocked');

    expect(fixture.drive.listCandidates).toHaveBeenCalledTimes(1);
    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({
        state: 'conflict', revalidationFailureStreak: 2,
        nextRevalidationAtMs: NOW_MS + 30 * 60_000 + 500,
      });
  });

  it('leaves a genuine concurrent conflict winner unchanged after adoption CAS loss', async () => {
    const fixture = await conflictFixture({ random: () => 0.5 });
    fixture.drive.identitySteps.push(page(exactDayFolder({ id: 'survivor-id' })));
    const reschedule = vi.spyOn(fixture.repository, 'rescheduleBlockedRevalidation');
    vi.spyOn(fixture.repository, 'adoptConflictCandidate').mockImplementationOnce(async (input) => {
      const winner = await fixture.repository.rescheduleBlockedRevalidation({
        id: input.expected.id,
        expectedRevision: input.expected.revision,
        errorCode: 'concurrent_winner',
        nowMs: NOW_MS + 1,
        nextRevalidationAtMs: NOW_MS + 45 * 60_000,
      });
      return { kind: 'lost', current: winner };
    });

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .resolves.toBe('still-blocked');

    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({
        errorCode: 'concurrent_winner', revalidationFailureStreak: 2,
        nextRevalidationAtMs: NOW_MS + 45 * 60_000,
      });
    expect(reschedule).toHaveBeenCalledTimes(2);
    expect(fixture.alerts.alert).not.toHaveBeenCalled();
  });

  it('restarts a rejected conflict page token once from page one', async () => {
    const fixture = await conflictFixture();
    fixture.drive.identitySteps.push(
      new DriveFolderPageTokenRejectedError(),
      page(exactDayFolder({ id: 'survivor-id' })),
    );

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .resolves.toBe('adopted');

    expect(fixture.drive.listCandidates).toHaveBeenCalledTimes(2);
    expect(fixture.drive.listCandidates.mock.calls.map(([input]) => input.pageToken))
      .toEqual([null, null]);
  });

  it('reschedules and surfaces uncertainty after a second rejected page token', async () => {
    const fixture = await conflictFixture({ random: () => 0 });
    fixture.drive.identitySteps.push(
      new DriveFolderPageTokenRejectedError(),
      new DriveFolderPageTokenRejectedError(),
    );

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .rejects.toBeInstanceOf(DriveFolderDiscoveryUncertainError);

    expect(fixture.drive.listCandidates).toHaveBeenCalledTimes(2);
    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({
        state: 'conflict', revalidationFailureStreak: 2,
        nextRevalidationAtMs: NOW_MS + 30 * 60_000,
      });
  });

  it('does not adopt partial conflict evidence when the page bound is exhausted', async () => {
    const fixture = await conflictFixture({ random: () => 0, maxPages: 2 });
    fixture.drive.identitySteps.push(
      {
        folders: [exactDayFolder({ id: 'partial-survivor' })],
        nextPageToken: 'page-2',
        incompleteSearch: false,
      },
      {
        folders: [],
        nextPageToken: 'page-3',
        incompleteSearch: false,
      },
    );

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .rejects.toBeInstanceOf(DriveFolderDiscoveryUncertainError);

    expect(fixture.drive.listCandidates).toHaveBeenCalledTimes(2);
    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({ state: 'conflict', folderId: 'conflict-marker-id' });
  });

  it('reschedules before surfacing a retryable provider failure', async () => {
    const fixture = await detachedFixture({ random: () => 0 });
    const providerError = new DriveTemporaryUnavailableError('provider unavailable');
    fixture.drive.exactFailures.set('detached-id', providerError);

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .rejects.toBe(providerError);

    expect(fixture.drive.loadExact).toHaveBeenCalledTimes(1);
    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({ revalidationFailureStreak: 2 });
  });

  it('returns still-blocked without a second provider operation when restore loses CAS', async () => {
    const fixture = await detachedFixture();
    fixture.drive.exact.set('detached-id', exactDayFolder());
    vi.spyOn(fixture.repository, 'restoreDetached').mockResolvedValueOnce(null);

    await expect(fixture.useCase.executeNext(connection, NOW_MS, signal()))
      .resolves.toBe('still-blocked');

    expect(fixture.drive.loadExact).toHaveBeenCalledTimes(1);
    expect(fixture.drive.listCandidates).not.toHaveBeenCalled();
  });

  it('does not claim or call Drive for an inactive generation', async () => {
    const fixture = await detachedFixture();
    const staged = DriveConnection.stage({
      id: 'generation-1', installationId: 'installation-1', nowMs: 1,
    });

    await expect(fixture.useCase.executeNext(staged, NOW_MS, signal()))
      .resolves.toBe('none');

    expect(fixture.drive.loadExact).not.toHaveBeenCalled();
    expect(fixture.drive.listCandidates).not.toHaveBeenCalled();
    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({ revision: 2, nextRevalidationAtMs: NOW_MS });
  });

  it('honors cancellation before claiming a blocked head', async () => {
    const fixture = await detachedFixture();
    const controller = new AbortController();
    const reason = new Error('shutdown');
    controller.abort(reason);

    await expect(fixture.useCase.executeNext(connection, NOW_MS, controller.signal))
      .rejects.toBe(reason);

    expect(fixture.drive.loadExact).not.toHaveBeenCalled();
    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({ revision: 2, nextRevalidationAtMs: NOW_MS });
  });

  it('does not reschedule after cancellation during the one provider read', async () => {
    const fixture = await detachedFixture();
    const controller = new AbortController();
    const reason = new Error('shutdown');
    fixture.drive.loadExact.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw reason;
    });

    await expect(fixture.useCase.executeNext(connection, NOW_MS, controller.signal))
      .rejects.toBe(reason);

    expect(fixture.drive.loadExact).toHaveBeenCalledTimes(1);
    expect(await fixture.repository.loadCurrent(connection.id, '2026/08/13'))
      .toMatchObject({
        revision: 3, revalidationFailureStreak: 1,
        nextRevalidationAtMs: NOW_MS + 60_000,
      });
  });
});

interface FixtureOptions {
  random?: () => number;
  maxPages?: number;
}

async function detachedFixture(options: FixtureOptions = {}) {
  return fixture('detached', 'detached-id', options);
}

async function conflictFixture(options: FixtureOptions = {}) {
  return fixture('conflict', 'conflict-marker-id', options);
}

async function fixture(
  state: 'detached' | 'conflict',
  folderId: string,
  options: FixtureOptions,
) {
  const repository = new InMemoryDriveFolderReservationRepository();
  await seedBlocked(repository, state, folderId);
  const drive = new FakeDriveFolderPort();
  const alerts = {
    alert: vi.fn<ArchiveAdminAlertPort['alert']>(async () => undefined),
  };
  const useCase = new RevalidateMotionArchiveBranchUseCase(
    drive,
    repository,
    new ArchiveRemoteMutationLockService(),
    alerts,
    {
      random: options.random,
      reservationId: () => 'adopted-reservation',
      pageSize: 100,
      maxPages: options.maxPages ?? 20,
    },
  );
  return { repository, drive, alerts, useCase };
}

async function seedBlocked(
  repository: InMemoryDriveFolderReservationRepository,
  state: 'detached' | 'conflict',
  folderId: string,
): Promise<DriveFolderReservation> {
  const stored = await repository.compareAndSetCurrent({
    expected: null,
    replacement: {
      id: `${state}-reservation`,
      installationId: 'installation-1',
      generationId: 'generation-1',
      normalizedPath: '2026/08/13',
      level: 'day',
      segmentName: '13',
      folderId,
      parentFolderId: 'existing-month',
    },
    nowMs: 1,
  });
  if (stored.kind !== 'stored') throw new Error('expected blocked fixture reservation');
  const verified = await repository.markVerified(
    stored.reservation.id,
    stored.reservation.revision,
    2,
  );
  if (verified === null) throw new Error('expected blocked fixture verification');
  const blocked = await repository.markBlocked(
    verified.id,
    verified.revision,
    state,
    'DRIVE_FOLDER_BRANCH_BLOCKED',
    3,
    NOW_MS,
  );
  if (blocked === null) throw new Error('expected blocked fixture transition');
  return blocked;
}

class FakeDriveFolderPort implements DriveFolderPort {
  readonly exact = new Map<string, DriveFolderMetadata | null>();
  readonly exactFailures = new Map<string, Error>();
  readonly identitySteps: (DriveFolderPage | Error)[] = [];

  readonly generateId = vi.fn(async () => {
    throw new Error('revalidation must not generate a Drive folder ID');
  });

  readonly loadExact = vi.fn(async (
    _connection: DriveConnection,
    folderId: string,
    _signal: AbortSignal,
  ): Promise<DriveFolderMetadata | null> => {
    const failure = this.exactFailures.get(folderId);
    if (failure !== undefined) throw failure;
    return this.exact.get(folderId) ?? null;
  });

  readonly listCandidates = vi.fn(async (
    _input: DriveFolderListInput,
    _signal: AbortSignal,
  ): Promise<DriveFolderPage> => {
    const next = this.identitySteps.shift() ?? emptyPage();
    if (next instanceof Error) throw next;
    return next;
  });

  readonly create = vi.fn(async (
    _input: DriveFolderCreateInput,
    _signal: AbortSignal,
  ): Promise<DriveFolderMetadata> => {
    throw new Error('revalidation must not create a Drive folder');
  });
}

function exactDayFolder(
  changed: Partial<DriveFolderMetadata> = {},
): DriveFolderMetadata {
  return {
    id: 'detached-id',
    name: '13',
    mimeType: 'application/vnd.google-apps.folder',
    parentIds: ['existing-month'],
    appProperties: dayProperties(),
    ownedByMe: true,
    ownerPermissionIds: ['owner-1'],
    permissionIds: ['owner-1'],
    shared: false,
    trashed: false,
    ...changed,
  };
}

function dayProperties(): Readonly<Record<string, string>> {
  return {
    a1v: '1',
    a1i: 'installation-1',
    a1g: 'generation-1',
    a1k: 'motion-day',
    a1p: '2026/08/13',
  };
}

function page(folder: DriveFolderMetadata): DriveFolderPage {
  return { folders: [folder], nextPageToken: null, incompleteSearch: false };
}

function emptyPage(): DriveFolderPage {
  return { folders: [], nextPageToken: null, incompleteSearch: false };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

const connection = DriveConnection.restore({
  id: 'generation-1',
  installationId: 'installation-1',
  status: 'active',
  revision: 1,
  permissionId: 'owner-1',
  email: null,
  displayName: null,
  folders: {
    rootId: 'root-1',
    motionId: 'motion-1',
    backupsId: 'backups-1',
  },
  createdAtMs: 1,
  updatedAtMs: 1,
  activatedAtMs: 1,
  retiredAtMs: null,
});
