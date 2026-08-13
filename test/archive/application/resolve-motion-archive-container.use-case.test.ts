import { describe, expect, it } from 'vitest';
import { ArchiveRemoteMutationLockService } from '../../../src/archive/application/archive-remote-mutation-lock.service';
import type {
  DriveFolderCreateInput,
  DriveFolderMetadata,
  DriveFolderPage,
  DriveFolderPort,
} from '../../../src/archive/application/ports/drive-folder.port';
import { DriveFolderPageTokenRejectedError } from '../../../src/archive/application/ports/drive-folder.port';
import type {
  DriveFolderReservationRepositoryPort,
  ReserveDriveFolder,
} from '../../../src/archive/application/ports/drive-folder-reservation-repository.port';
import { ResolveMotionArchiveContainerUseCase } from '../../../src/archive/application/use-cases/resolve-motion-archive-container.use-case';
import { encodeMotionFolderAppProperties } from '../../../src/archive/domain/app-properties';
import type { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import { DriveConnection as Connection } from '../../../src/archive/domain/drive-connection.entity';
import type { DriveFolderReservation } from '../../../src/archive/domain/drive-folder-reservation.entity';
import { DriveFolderBranchBlockedError } from '../../../src/archive/domain/errors/drive-folder-branch-blocked.error';
import { DriveTemporaryUnavailableError } from '../../../src/archive/domain/errors/drive-temporary-unavailable.error';
import { MotionArchivePath } from '../../../src/archive/domain/motion-archive-path.value-object';
import { InMemoryDriveFolderReservationRepository } from '../../../src/archive/infrastructure/persistence/in-memory-drive-folder-reservation.repository';

const signal = new AbortController().signal;
const path = MotionArchivePath.parse('2026/08/13/010203-front-door.avi');

describe('ResolveMotionArchiveContainerUseCase', () => {
  it('reuses an all-existing exact year/month/day chain without discovery or creation', async () => {
    const context = createContext();
    await seedChain(context);
    context.clearCalls();

    await expect(context.useCase.execute(connection(), path, signal)).resolves.toBe('existing-day');

    expect(context.drive.calls).toEqual([
      'load:existing-year', 'load:existing-month', 'load:existing-day',
    ]);
    expect(context.journal).toEqual(['verify', 'verify', 'verify']);
  });

  it('creates only the missing month and day after reusing an exact year head', async () => {
    const context = createContext(['month-folder-id', 'day-folder-id']);
    await seedLevel(context.repository, context.drive, {
      normalizedPath: '2026', level: 'year', role: 'motion-year', segmentName: '2026',
      folderId: 'existing-year', parentFolderId: 'motion-1',
    });
    context.clearCalls();
    context.drive.pages.push(emptyPage(), emptyPage());

    await expect(context.useCase.execute(connection(), path, signal)).resolves.toBe('day-folder-id');

    expect(context.journal).toEqual([
      'verify',
      'generate', 'reserve', 'create', 'verify',
      'generate', 'reserve', 'create', 'verify',
    ]);
    expect(context.drive.exact.get('month-folder-id')).toMatchObject({ parentIds: ['existing-year'], name: '08' });
    expect(context.drive.exact.get('day-folder-id')).toMatchObject({ parentIds: ['month-folder-id'], name: '13' });
  });

  it('recovers an ambiguous create only by reloading the generated exact ID', async () => {
    const context = createContext(['year-folder-id', 'month-folder-id', 'day-folder-id']);
    context.drive.pages.push(emptyPage(), emptyPage(), emptyPage());
    context.drive.createFailures.push({
      error: new DriveTemporaryUnavailableError(),
      persist: true,
    });

    await expect(context.useCase.execute(connection(), path, signal)).resolves.toBe('day-folder-id');

    expect(context.drive.calls.filter((call) => call.startsWith('load:'))).toEqual(['load:year-folder-id']);
    expect(context.drive.calls).not.toContain('load:month-folder-id');
    expect(context.drive.calls).not.toContain('load:day-folder-id');
    expect(context.repository.history().filter((row) => row.state === 'verified')).toHaveLength(3);
  });

  it('adopts one exact candidate at every level without generating or creating folders', async () => {
    const context = createContext();
    const year = folderFor('candidate-year', '2026', 'motion-1', 'motion-year', '2026');
    const month = folderFor('candidate-month', '08', 'candidate-year', 'motion-month', '2026/08');
    const day = folderFor('candidate-day', '13', 'candidate-month', 'motion-day', '2026/08/13');
    for (const folder of [year, month, day]) context.drive.exact.set(folder.id, folder);
    context.drive.pages.push(page(year), page(month), page(day));

    await expect(context.useCase.execute(connection(), path, signal)).resolves.toBe('candidate-day');

    expect(context.drive.calls.some((call) => call.startsWith('generate:') || call.startsWith('create:'))).toBe(false);
    expect(context.repository.history()).toEqual([
      expect.objectContaining({ folderId: 'candidate-year', state: 'verified' }),
      expect.objectContaining({ folderId: 'candidate-month', state: 'verified' }),
      expect.objectContaining({ folderId: 'candidate-day', state: 'verified' }),
    ]);
  });

  it('restarts one rejected page token from page one and discards the partial traversal', async () => {
    const context = createContext();
    const stale = folderFor('stale-year', '2026', 'motion-1', 'motion-year', '2026');
    const winner = folderFor('winner-year', '2026', 'motion-1', 'motion-year', '2026');
    const month = folderFor('candidate-month', '08', 'winner-year', 'motion-month', '2026/08');
    const day = folderFor('candidate-day', '13', 'candidate-month', 'motion-day', '2026/08/13');
    for (const folder of [stale, winner, month, day]) context.drive.exact.set(folder.id, folder);
    context.drive.pages.push(
      { folders: [stale], nextPageToken: 'next-year', incompleteSearch: false },
      new DriveFolderPageTokenRejectedError(),
      page(winner), page(month), page(day),
    );

    await expect(context.useCase.execute(connection(), path, signal)).resolves.toBe('candidate-day');

    expect(context.drive.calls.filter((call) => call.startsWith('list:'))).toEqual([
      'list:first', 'list:next-year', 'list:first', 'list:first', 'list:first',
    ]);
    expect(context.repository.history().some((row) => row.folderId === 'stale-year')).toBe(false);
  });

  it('does not restart candidate paging after a second rejected page token', async () => {
    const context = createContext();
    context.drive.pages.push(
      new DriveFolderPageTokenRejectedError(),
      new DriveFolderPageTokenRejectedError(),
    );

    await expect(context.useCase.execute(connection(), path, signal)).rejects.toBeInstanceOf(
      DriveFolderPageTokenRejectedError,
    );

    expect(context.drive.calls).toEqual(['list:first', 'list:first']);
    expect(context.repository.history()).toEqual([]);
  });

  it('serializes concurrent same-path resolution and preserves one folder identity per level', async () => {
    const context = createContext(['year-folder-id', 'month-folder-id', 'day-folder-id']);
    context.drive.pages.push(emptyPage(), emptyPage(), emptyPage());

    const results = await Promise.all([
      context.useCase.execute(connection(), path, signal),
      context.useCase.execute(connection(), path, signal),
    ]);

    expect(results).toEqual(['day-folder-id', 'day-folder-id']);
    expect(context.drive.calls.filter((call) => call.startsWith('create:'))).toEqual([
      'create:year-folder-id', 'create:month-folder-id', 'create:day-folder-id',
    ]);
    expect(context.repository.history()).toHaveLength(3);
  });

  it.each(['missing', 'trashed'] as const)('append-only replaces a %s worker-controlled year and supersedes descendants', async (condition) => {
    const context = createContext(['replacement-year', 'replacement-month', 'replacement-day']);
    await seedChain(context);
    if (condition === 'missing') context.drive.exact.delete('existing-year');
    else context.drive.exact.set('existing-year', { ...context.drive.exact.get('existing-year')!, trashed: true });
    context.clearCalls();
    context.drive.pages.push(emptyPage(), emptyPage());

    await expect(context.useCase.execute(connection(), path, signal)).resolves.toBe('replacement-day');

    const history = context.repository.history();
    expect(history.find((row) => row.folderId === 'existing-year')).toMatchObject({ state: 'missing', currentSlot: null });
    expect(history.find((row) => row.folderId === 'existing-month')).toMatchObject({ state: 'superseded', currentSlot: null });
    expect(history.find((row) => row.folderId === 'existing-day')).toMatchObject({ state: 'superseded', currentSlot: null });
    expect(history.filter((row) => row.state === 'verified').map((row) => row.folderId)).toEqual([
      'replacement-year', 'replacement-month', 'replacement-day',
    ]);
    expect(context.drive.calls.slice(0, 3)).toEqual([
      'load:existing-year', 'generate:replacement-year', 'create:replacement-year',
    ]);
  });

  it.each([
    ['incomplete search', { folders: [], nextPageToken: null, incompleteSearch: true } as DriveFolderPage],
    ['multiple exact candidates', null],
  ] as const)('durably marks %s as a conflict without creating a folder', async (scenario, configuredPage) => {
    const context = createContext(['conflict-marker-id']);
    const left = folderFor('left-year', '2026', 'motion-1', 'motion-year', '2026');
    const right = folderFor('right-year', '2026', 'motion-1', 'motion-year', '2026');
    context.drive.pages.push(configuredPage ?? { folders: [left, right], nextPageToken: null, incompleteSearch: false });

    await expect(context.useCase.execute(connection(), path, signal)).rejects.toMatchObject({
      name: 'DriveFolderBranchBlockedError', code: 'DRIVE_FOLDER_BRANCH_BLOCKED',
    });

    expect(await context.repository.loadCurrent('generation-1', '2026')).toMatchObject({ state: 'conflict' });
    expect(context.drive.calls.some((call) => call.startsWith('create:'))).toBe(false);
    expect(context.drive.calls.filter((call) => call === 'list:first')).toHaveLength(1);
  });

  it('reloads and uses the winning head after losing the current-slot reservation CAS', async () => {
    const base = new InMemoryDriveFolderReservationRepository();
    const drive = new FakeDriveFolderPort(['losing-year-id', 'month-folder-id', 'day-folder-id']);
    const winner = folderFor('winning-year-id', '2026', 'motion-1', 'motion-year', '2026');
    drive.exact.set(winner.id, winner);
    drive.pages.push(emptyPage(), emptyPage(), emptyPage());
    const repository = new LoseFirstCurrentSlotRepository(base, winner.id);
    const context = createContext([], drive, repository);

    await expect(context.useCase.execute(connection(), path, signal)).resolves.toBe('day-folder-id');

    expect(drive.calls).toContain('load:winning-year-id');
    expect(drive.calls).not.toContain('create:losing-year-id');
    expect(await base.loadCurrent('generation-1', '2026')).toMatchObject({ folderId: 'winning-year-id', state: 'verified' });
  });

  it('reloads a revision-changed head and durably detaches it after the first block CAS loses', async () => {
    const base = new InMemoryDriveFolderReservationRepository();
    const drive = new FakeDriveFolderPort();
    const stored = await base.compareAndSetCurrent({
      expected: null,
      replacement: {
        id: 'year-reservation', installationId: 'installation-1', generationId: 'generation-1',
        normalizedPath: '2026', level: 'year', segmentName: '2026',
        folderId: 'existing-year', parentFolderId: 'motion-1',
      },
      nowMs: 1,
    });
    if (stored.kind !== 'stored') throw new Error('expected seeded reservation');
    drive.exact.set('existing-year', {
      ...folderFor('existing-year', '2026', 'motion-1', 'motion-year', '2026'),
      name: 'renamed-by-user',
    });
    const repository = new FlakyMarkBlockedRepository(base);
    const context = createContext([], drive, repository);

    await expect(context.useCase.execute(connection(), path, signal)).rejects.toBeInstanceOf(
      DriveFolderBranchBlockedError,
    );

    expect(repository.blockAttempts).toBe(2);
    expect(drive.calls).toEqual(['load:existing-year', 'load:existing-year']);
    expect(await base.loadCurrent('generation-1', '2026')).toMatchObject({
      state: 'detached', errorCode: 'DRIVE_FOLDER_BRANCH_BLOCKED', revision: 2,
    });
  });

  it('bounds repeated nullable block CAS outcomes with a sanitized branch-blocked error', async () => {
    const base = new InMemoryDriveFolderReservationRepository();
    const drive = new FakeDriveFolderPort();
    await seedLevel(base, drive, {
      normalizedPath: '2026', level: 'year', role: 'motion-year', segmentName: '2026',
      folderId: 'existing-year', parentFolderId: 'motion-1',
    });
    drive.exact.set('existing-year', {
      ...drive.exact.get('existing-year')!,
      name: 'renamed-by-user',
    });
    const repository = new FlakyMarkBlockedRepository(base, Number.MAX_SAFE_INTEGER);
    const context = createContext([], drive, repository);

    await expect(context.useCase.execute(connection(), path, signal)).rejects.toMatchObject({
      name: 'DriveFolderBranchBlockedError',
      code: 'DRIVE_FOLDER_BRANCH_BLOCKED',
      message: 'Drive motion folder branch is blocked',
    });

    expect(repository.blockAttempts).toBe(4);
    expect(await base.loadCurrent('generation-1', '2026')).toMatchObject({ state: 'verified' });
  });

  it('exact-validates and uses a winner when conflict-marker reservation loses its CAS', async () => {
    const base = new InMemoryDriveFolderReservationRepository();
    const drive = new FakeDriveFolderPort(['losing-conflict-marker', 'month-folder-id', 'day-folder-id']);
    const winner = folderFor('winning-year-id', '2026', 'motion-1', 'motion-year', '2026');
    const duplicate = folderFor('duplicate-year-id', '2026', 'motion-1', 'motion-year', '2026');
    drive.exact.set(winner.id, winner);
    drive.pages.push(
      { folders: [winner, duplicate], nextPageToken: null, incompleteSearch: false },
      emptyPage(),
      emptyPage(),
    );
    const repository = new LoseFirstCurrentSlotRepository(base, winner.id);
    const context = createContext([], drive, repository);

    await expect(context.useCase.execute(connection(), path, signal)).resolves.toBe('day-folder-id');

    expect(await base.loadCurrent('generation-1', '2026')).toMatchObject({
      folderId: 'winning-year-id', state: 'verified', errorCode: null,
    });
    expect(base.history().some((row) => row.state === 'conflict')).toBe(false);
    expect(drive.calls).toContain('load:winning-year-id');
    expect(drive.calls).not.toContain('create:losing-conflict-marker');
  });

  it.each(['detached', 'conflict'] as const)('rejects an already-%s head before any provider operation', async (state) => {
    const context = createContext();
    await seedLevel(context.repository, context.drive, {
      normalizedPath: '2026', level: 'year', role: 'motion-year', segmentName: '2026',
      folderId: 'existing-year', parentFolderId: 'motion-1',
    });
    const current = await context.repository.loadCurrent('generation-1', '2026');
    if (current === null) throw new Error('expected seeded head');
    await context.repository.markBlocked(current.id, current.revision, state, 'old-sanitized-code', 2);
    context.clearCalls();

    await expect(context.useCase.execute(connection(), path, signal)).rejects.toBeInstanceOf(DriveFolderBranchBlockedError);

    expect(context.drive.calls).toEqual([]);
  });

  it.each([
    ['renamed', (folder: DriveFolderMetadata) => ({ ...folder, name: 'renamed-by-user' })],
    ['moved', (folder: DriveFolderMetadata) => ({ ...folder, parentIds: ['another-parent'] })],
    ['shared', (folder: DriveFolderMetadata) => ({ ...folder, shared: true, permissionIds: ['owner-1', 'reader-1'] })],
    ['property-modified', (folder: DriveFolderMetadata) => ({
      ...folder,
      appProperties: { ...folder.appProperties, a1p: '2025' },
    })],
  ] as const)('blocks a %s verified head without listing or creating', async (_scenario, mutate) => {
    const context = createContext();
    await seedLevel(context.repository, context.drive, {
      normalizedPath: '2026', level: 'year', role: 'motion-year', segmentName: '2026',
      folderId: 'existing-year', parentFolderId: 'motion-1',
    });
    context.drive.exact.set('existing-year', mutate(context.drive.exact.get('existing-year')!));
    context.clearCalls();

    const failure = await context.useCase.execute(connection(), path, signal).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: 'DriveFolderBranchBlockedError',
      code: 'DRIVE_FOLDER_BRANCH_BLOCKED',
      message: 'Drive motion folder branch is blocked',
    });
    expect(JSON.stringify(failure)).not.toContain('existing-year');
    expect(JSON.stringify(failure)).not.toContain('2026');
    expect(context.drive.calls).toEqual(['load:existing-year']);
    expect(await context.repository.loadCurrent('generation-1', '2026')).toMatchObject({
      state: 'detached', errorCode: 'DRIVE_FOLDER_BRANCH_BLOCKED',
    });
  });
});

class FakeDriveFolderPort implements DriveFolderPort {
  readonly exact = new Map<string, DriveFolderMetadata>();
  readonly pages: (DriveFolderPage | Error)[] = [];
  readonly calls: string[] = [];
  readonly createFailures: { error: Error; persist: boolean }[] = [];
  readonly journal: string[] = [];

  constructor(readonly generatedIds: string[] = []) {}

  async generateId(): Promise<string> {
    const id = this.generatedIds.shift();
    if (id === undefined) throw new Error('fake generated ID queue exhausted');
    this.calls.push(`generate:${id}`);
    this.journal.push('generate');
    return id;
  }

  async loadExact(_connection: DriveConnection, folderId: string): Promise<DriveFolderMetadata | null> {
    this.calls.push(`load:${folderId}`);
    return this.exact.get(folderId) ?? null;
  }

  async listCandidates(input: { pageToken: string | null }): Promise<DriveFolderPage> {
    this.calls.push(`list:${input.pageToken ?? 'first'}`);
    const next = this.pages.shift() ?? emptyPage();
    if (next instanceof Error) throw next;
    return next;
  }

  async create(input: DriveFolderCreateInput): Promise<DriveFolderMetadata> {
    this.calls.push(`create:${input.id}`);
    this.journal.push('create');
    const metadata = exactFolder(input.id, input.name, input.parentId, input.appProperties);
    const failure = this.createFailures.shift();
    if (failure !== undefined) {
      if (failure.persist) this.exact.set(input.id, metadata);
      throw failure.error;
    }
    this.exact.set(input.id, metadata);
    return metadata;
  }
}

class JournalReservationRepository implements DriveFolderReservationRepositoryPort {
  constructor(
    readonly delegate: InMemoryDriveFolderReservationRepository,
    private readonly journal: string[],
  ) {}

  loadCurrent(generationId: string, normalizedPath: string): Promise<DriveFolderReservation | null> {
    return this.delegate.loadCurrent(generationId, normalizedPath);
  }

  compareAndSetCurrent(input: { expected: { id: string; revision: number } | null; replacement: ReserveDriveFolder; nowMs: number }) {
    this.journal.push('reserve');
    return this.delegate.compareAndSetCurrent(input);
  }

  markVerified(id: string, expectedRevision: number, nowMs: number) {
    this.journal.push('verify');
    return this.delegate.markVerified(id, expectedRevision, nowMs);
  }

  markBlocked(id: string, expectedRevision: number, state: 'detached' | 'conflict', errorCode: string, nowMs: number) {
    return this.delegate.markBlocked(id, expectedRevision, state, errorCode, nowMs);
  }

  replaceMissing(input: { expected: { id: string; revision: number; folderId: string }; replacement: ReserveDriveFolder; nowMs: number }) {
    this.journal.push('reserve');
    return this.delegate.replaceMissing(input);
  }

  countUnhealthy(generationId: string): Promise<number> {
    return this.delegate.countUnhealthy(generationId);
  }

  history(): readonly DriveFolderReservation[] {
    return this.delegate.history();
  }
}

class LoseFirstCurrentSlotRepository implements DriveFolderReservationRepositoryPort {
  private lost = false;

  constructor(
    private readonly delegate: InMemoryDriveFolderReservationRepository,
    private readonly winnerFolderId: string,
  ) {}

  loadCurrent(generationId: string, normalizedPath: string) {
    return this.delegate.loadCurrent(generationId, normalizedPath);
  }

  async compareAndSetCurrent(input: { expected: { id: string; revision: number } | null; replacement: ReserveDriveFolder; nowMs: number }) {
    if (!this.lost && input.replacement.level === 'year') {
      this.lost = true;
      const winner = await this.delegate.compareAndSetCurrent({
        ...input,
        replacement: {
          ...input.replacement,
          id: 'winning-reservation-id',
          folderId: this.winnerFolderId,
        },
      });
      if (winner.kind !== 'stored') throw new Error('expected synthetic winner');
      return { kind: 'lost' as const, current: winner.reservation };
    }
    return this.delegate.compareAndSetCurrent(input);
  }

  markVerified(id: string, expectedRevision: number, nowMs: number) {
    return this.delegate.markVerified(id, expectedRevision, nowMs);
  }

  markBlocked(id: string, expectedRevision: number, state: 'detached' | 'conflict', errorCode: string, nowMs: number) {
    return this.delegate.markBlocked(id, expectedRevision, state, errorCode, nowMs);
  }

  replaceMissing(input: { expected: { id: string; revision: number; folderId: string }; replacement: ReserveDriveFolder; nowMs: number }) {
    return this.delegate.replaceMissing(input);
  }

  countUnhealthy(generationId: string) {
    return this.delegate.countUnhealthy(generationId);
  }
}

class FlakyMarkBlockedRepository implements DriveFolderReservationRepositoryPort {
  blockAttempts = 0;

  constructor(
    private readonly delegate: InMemoryDriveFolderReservationRepository,
    private remainingLosses = 1,
  ) {}

  loadCurrent(generationId: string, normalizedPath: string) {
    return this.delegate.loadCurrent(generationId, normalizedPath);
  }

  compareAndSetCurrent(input: { expected: { id: string; revision: number } | null; replacement: ReserveDriveFolder; nowMs: number }) {
    return this.delegate.compareAndSetCurrent(input);
  }

  markVerified(id: string, expectedRevision: number, nowMs: number) {
    return this.delegate.markVerified(id, expectedRevision, nowMs);
  }

  async markBlocked(
    id: string,
    expectedRevision: number,
    state: 'detached' | 'conflict',
    errorCode: string,
    nowMs: number,
  ) {
    this.blockAttempts += 1;
    if (this.remainingLosses > 0) {
      this.remainingLosses -= 1;
      const advanced = await this.delegate.markVerified(id, expectedRevision, nowMs);
      if (advanced === null) throw new Error('expected synthetic revision winner');
      return null;
    }
    return this.delegate.markBlocked(id, expectedRevision, state, errorCode, nowMs);
  }

  replaceMissing(input: { expected: { id: string; revision: number; folderId: string }; replacement: ReserveDriveFolder; nowMs: number }) {
    return this.delegate.replaceMissing(input);
  }

  countUnhealthy(generationId: string) {
    return this.delegate.countUnhealthy(generationId);
  }
}

function createContext(
  generatedIds: string[] = [],
  drive = new FakeDriveFolderPort([...generatedIds]),
  providedRepository?: DriveFolderReservationRepositoryPort,
) {
  const journal = drive.journal;
  const memory = providedRepository instanceof LoseFirstCurrentSlotRepository
    ? providedRepository
    : new InMemoryDriveFolderReservationRepository();
  const repository = providedRepository ?? new JournalReservationRepository(memory as InMemoryDriveFolderReservationRepository, journal);
  let reservation = 0;
  const useCase = new ResolveMotionArchiveContainerUseCase(
    drive,
    repository,
    new ArchiveRemoteMutationLockService(),
    { now: () => 100, reservationId: () => `reservation-${++reservation}`, pageSize: 100, maxPages: 5 },
  );
  return {
    drive,
    repository: repository as JournalReservationRepository,
    useCase,
    journal,
    clearCalls: () => {
      drive.calls.length = 0;
      journal.length = 0;
    },
  };
}

async function seedChain(context: ReturnType<typeof createContext>): Promise<void> {
  await seedLevel(context.repository, context.drive, {
    normalizedPath: '2026', level: 'year', role: 'motion-year', segmentName: '2026',
    folderId: 'existing-year', parentFolderId: 'motion-1',
  });
  await seedLevel(context.repository, context.drive, {
    normalizedPath: '2026/08', level: 'month', role: 'motion-month', segmentName: '08',
    folderId: 'existing-month', parentFolderId: 'existing-year',
  });
  await seedLevel(context.repository, context.drive, {
    normalizedPath: '2026/08/13', level: 'day', role: 'motion-day', segmentName: '13',
    folderId: 'existing-day', parentFolderId: 'existing-month',
  });
}

async function seedLevel(
  repository: DriveFolderReservationRepositoryPort,
  drive: FakeDriveFolderPort,
  input: {
    normalizedPath: string;
    level: 'year' | 'month' | 'day';
    role: 'motion-year' | 'motion-month' | 'motion-day';
    segmentName: string;
    folderId: string;
    parentFolderId: string;
  },
): Promise<void> {
  const stored = await repository.compareAndSetCurrent({
    expected: null,
    replacement: {
      id: `seed-${input.level}`,
      installationId: 'installation-1',
      generationId: 'generation-1',
      normalizedPath: input.normalizedPath,
      level: input.level,
      segmentName: input.segmentName,
      folderId: input.folderId,
      parentFolderId: input.parentFolderId,
    },
    nowMs: 1,
  });
  if (stored.kind !== 'stored') throw new Error('expected seeded reservation');
  const verified = await repository.markVerified(stored.reservation.id, stored.reservation.revision, 1);
  if (verified === null) throw new Error('expected seeded verification');
  drive.exact.set(input.folderId, folderFor(
    input.folderId,
    input.segmentName,
    input.parentFolderId,
    input.role,
    input.normalizedPath,
  ));
}

function connection(): DriveConnection {
  return Connection.restore({
    id: 'generation-1',
    installationId: 'installation-1',
    status: 'active',
    revision: 1,
    permissionId: 'owner-1',
    email: null,
    displayName: null,
    folders: { rootId: 'root-1', motionId: 'motion-1', backupsId: 'backups-1' },
    createdAtMs: 1,
    updatedAtMs: 1,
    activatedAtMs: 1,
    retiredAtMs: null,
  });
}

function folderFor(
  id: string,
  name: string,
  parentId: string,
  role: 'motion-year' | 'motion-month' | 'motion-day',
  normalizedPath: string,
): DriveFolderMetadata {
  return exactFolder(id, name, parentId, encodeMotionFolderAppProperties({
    installationId: 'installation-1', generationId: 'generation-1', role, normalizedPath, schemaVersion: 1,
  }));
}

function exactFolder(
  id: string,
  name: string,
  parentId: string,
  appProperties: Readonly<Record<string, string>>,
): DriveFolderMetadata {
  return {
    id,
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parentIds: [parentId],
    appProperties,
    ownedByMe: true,
    ownerPermissionIds: ['owner-1'],
    permissionIds: ['owner-1'],
    shared: false,
    trashed: false,
  };
}

function emptyPage(): DriveFolderPage {
  return { folders: [], nextPageToken: null, incompleteSearch: false };
}

function page(folder: DriveFolderMetadata): DriveFolderPage {
  return { folders: [folder], nextPageToken: null, incompleteSearch: false };
}
