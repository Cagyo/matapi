import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ArchiveObjectAttempt,
  ArchiveSchedulerState,
  RetentionSelection,
} from '../../../src/archive/application/ports/archive-artifact-repository.port';
import type { ArchiveClockPort } from '../../../src/archive/application/ports/archive-clock.port';
import type {
  DriveQuotaReclamationState,
} from '../../../src/archive/application/ports/drive-credential-repository.port';
import { ApplyDriveRetentionUseCase } from '../../../src/archive/application/use-cases/apply-drive-retention.use-case';
import { encodeArchiveAppProperties } from '../../../src/archive/domain/app-properties';
import { ArchiveArtifact } from '../../../src/archive/domain/archive-artifact.entity';
import { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import type { VerifiedDriveObject } from '../../../src/archive/domain/drive-object-metadata.value-object';
import { DriveClockUnhealthyError } from '../../../src/archive/domain/errors/drive-clock-unhealthy.error';
import { DriveQuotaExceededError } from '../../../src/archive/domain/errors/drive-quota-exceeded.error';

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.UTC(2030, 0, 1);
const LOCAL_BYTES = Buffer.from('local');
const DIGEST = createHash('sha256').update(LOCAL_BYTES).digest('hex');
const signal = new AbortController().signal;

describe('ApplyDriveRetentionUseCase', () => {
  it.each([
    ['unsynchronized', { synchronized: false, plausible: true }],
    ['far-past', { nowMs: Date.UTC(2000, 0, 1), synchronized: true, plausible: false }],
    ['far-future', { nowMs: Date.UTC(2200, 0, 1), synchronized: true, plausible: false }],
  ] as const)('deletes nothing when clock input is %s', async (_condition, update) => {
    const fixture = makeFixture();
    fixture.clock.reading = { ...fixture.clock.reading, ...update };

    await expect(fixture.useCase.execute({ requiredBytes: 5 }, signal))
      .rejects.toBeInstanceOf(DriveClockUnhealthyError);

    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it.each([
    ['missing-provider-time', null],
    ['invalid-provider-time', Number.NaN],
  ] as const)('deletes nothing when clock input is %s', async (_condition, providerCreatedAtMs) => {
    const fixture = makeFixture();
    fixture.addCandidate('bad-time', 'database_backup', providerCreatedAtMs!);

    await expect(fixture.useCase.execute({ requiredBytes: 5 }, signal))
      .rejects.toBeInstanceOf(DriveClockUnhealthyError);

    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it('expires backups strictly older than seven days using provider creation time', async () => {
    const fixture = makeFixture({
      quota: {
        limitBytes: 100,
        usageBytes: 0,
        usageInDriveBytes: 0,
        usageInDriveTrashBytes: 0,
      },
    });
    fixture.addCandidate('at-boundary', 'database_backup', NOW - 7 * DAY_MS);
    fixture.addCandidate('expired', 'database_backup', NOW - 7 * DAY_MS - 1);

    await fixture.useCase.execute({ requiredBytes: 0 }, signal);

    expect(fixture.drive.deletedIds).toEqual(['expired']);
  });

  it('treats the exact 90-day video boundary as young and protects its sole remote copy', async () => {
    const fixture = makeFixture();
    fixture.addCandidate('old', 'motion_video', NOW - 90 * DAY_MS - 1);
    fixture.addCandidate('at-boundary', 'motion_video', NOW - 90 * DAY_MS);

    await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(fixture.drive.deletedIds).toEqual(['old']);
  });

  it('orders expired backups, old videos, then locally-backed young videos', async () => {
    const fixture = makeFixture();
    fixture.addCandidate('video-young-remote', 'motion_video', NOW - DAY_MS);
    fixture.addCandidate('video-young-local', 'motion_video', NOW - 2 * DAY_MS, true);
    fixture.addCandidate('video-old', 'motion_video', NOW - 91 * DAY_MS);
    fixture.addCandidate('backup-expired', 'database_backup', NOW - 8 * DAY_MS);

    await fixture.useCase.execute({ requiredBytes: 15 }, signal);

    expect(fixture.drive.deletedIds).toEqual([
      'backup-expired',
      'video-old',
      'video-young-local',
    ]);
  });

  it('selects no more exact objects after their bytes cover the deficit', async () => {
    const fixture = makeFixture();
    fixture.addCandidate('oldest', 'motion_video', NOW - 93 * DAY_MS);
    fixture.addCandidate('middle', 'motion_video', NOW - 92 * DAY_MS);
    fixture.addCandidate('newest', 'motion_video', NOW - 91 * DAY_MS);

    await fixture.useCase.execute({ requiredBytes: 6 }, signal);

    expect(fixture.drive.deletedIds).toEqual(['oldest', 'middle']);
  });

  it('does not let retired-generation rows consume the bounded active selection', async () => {
    const fixture = makeFixture({ candidateLimit: 1 });
    fixture.addCandidate('retired-oldest', 'motion_video', NOW - 100 * DAY_MS);
    fixture.repository.attempts.set('retired-oldest', {
      ...fixture.repository.attempts.get('retired-oldest')!,
      generationId: 'retired-generation',
    });
    fixture.addCandidate('retired-second', 'motion_video', NOW - 99 * DAY_MS);
    fixture.repository.attempts.set('retired-second', {
      ...fixture.repository.attempts.get('retired-second')!,
      generationId: 'retired-generation',
    });
    fixture.addCandidate('active-old', 'motion_video', NOW - 91 * DAY_MS);

    await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(fixture.drive.deletedIds).toEqual(['active-old']);
  });

  it('preserves quota candidates when all eligible bytes cannot cover the deficit', async () => {
    const fixture = makeFixture();
    fixture.addCandidate('only-five-bytes', 'motion_video', NOW - 91 * DAY_MS);

    const result = await fixture.useCase.execute({ requiredBytes: 10 }, signal);

    expect(result.remainingDeficitBytes).toBe(10);
    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it.each([
    ['missing limit', { limitBytes: null, usageBytes: 100, usageInDriveBytes: 80, usageInDriveTrashBytes: 0 }],
    ['negative usage', { limitBytes: 100, usageBytes: -1, usageInDriveBytes: 0, usageInDriveTrashBytes: 0 }],
    ['Drive usage over total usage', { limitBytes: 100, usageBytes: 10, usageInDriveBytes: 11, usageInDriveTrashBytes: 0 }],
    ['Trash usage over Drive usage', { limitBytes: 100, usageBytes: 10, usageInDriveBytes: 5, usageInDriveTrashBytes: 6 }],
  ])('fails closed for %s quota metadata', async (_condition, quota) => {
    const fixture = makeFixture({ quota });
    fixture.addCandidate('old', 'motion_video', NOW - 91 * DAY_MS);

    await expect(fixture.useCase.execute({ requiredBytes: 5 }, signal))
      .rejects.toBeInstanceOf(DriveQuotaExceededError);

    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it('uses total account usage so unrelated Drive data contributes to the deficit', async () => {
    const fixture = makeFixture({
      quota: {
        limitBytes: 100,
        usageBytes: 98,
        usageInDriveBytes: 10,
        usageInDriveTrashBytes: 0,
      },
    });
    fixture.addCandidate('old', 'motion_video', NOW - 91 * DAY_MS);

    await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(fixture.drive.deletedIds).toEqual(['old']);
  });

  it('does not cascade deletion during the 72-hour accounting window', async () => {
    const fixture = makeFixture({
      accounting: { windowStartedMs: NOW - 60 * 60 * 1_000, reclaimedBytes: 100 },
    });
    fixture.addCandidate('old', 'motion_video', NOW - 91 * DAY_MS);

    const result = await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(result.accountingWindowActive).toBe(true);
    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it('ends the accounting window early when refreshed quota covers the real upload', async () => {
    const fixture = makeFixture({
      quota: { limitBytes: 100, usageBytes: 90 },
      accounting: { windowStartedMs: NOW - 60 * 60 * 1_000, reclaimedBytes: 5 },
    });

    await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(fixture.credentials.accounting).toEqual({ windowStartedMs: null, reclaimedBytes: 0 });
    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it('does not clear accounting merely because a zero-byte maintenance run has no deficit', async () => {
    const accounting = { windowStartedMs: NOW - 60 * 60 * 1_000, reclaimedBytes: 5 };
    const fixture = makeFixture({ accounting });
    fixture.addCandidate('expired', 'database_backup', NOW - 8 * DAY_MS);

    await fixture.useCase.execute({ requiredBytes: 0 }, signal);

    expect(fixture.credentials.accounting).toEqual(accounting);
    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it('does not treat stale free space below the pending upload size as quota catch-up', async () => {
    const accounting = { windowStartedMs: NOW - 60 * 60 * 1_000, reclaimedBytes: 10 };
    const fixture = makeFixture({
      quota: {
        limitBytes: 100,
        usageBytes: 50,
        usageInDriveBytes: 40,
        usageInDriveTrashBytes: 0,
      },
      accounting,
    });
    fixture.addCandidate('old', 'motion_video', NOW - 91 * DAY_MS);

    await fixture.useCase.execute({ requiredBytes: 60 }, signal);

    expect(fixture.credentials.accounting).toEqual(accounting);
    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it('ends the accounting window early only after a real successful upload', async () => {
    const started = NOW - 60 * 60 * 1_000;
    const fixture = makeFixture({
      accounting: { windowStartedMs: started, reclaimedBytes: 5 },
      lastUploadSuccessMs: started + 1,
    });
    fixture.addCandidate('old', 'motion_video', NOW - 91 * DAY_MS);

    await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(fixture.drive.deletedIds).toEqual(['old']);
  });

  it.each([
    ['parent', { parentId: 'other-folder' }],
    ['properties', { appProperties: {} }],
    ['size', { size: 6 }],
    ['sha256', { sha256: 'f'.repeat(64) }],
    ['head revision', { headRevisionId: 'changed' }],
    ['version', { version: '2' }],
    ['sharing', { sharing: { ownerPermissionId: 'owner-1', shared: true, permissionIds: ['owner-1', 'reader-1'] } }],
    ['ownership', { ownedByMe: false }],
    ['owner permission', { sharing: { ownerPermissionId: 'owner-2', shared: false, permissionIds: ['owner-2'] } }],
    ['delete capability', { canDelete: false }],
    ['Trash state', { trashed: true }],
  ] as const)('detaches and preserves an exact candidate after %s changes', async (_change, update) => {
    const fixture = makeFixture();
    fixture.addCandidate('old', 'motion_video', NOW - 91 * DAY_MS);
    fixture.drive.objects.set('old', { ...fixture.drive.objects.get('old')!, ...update });

    await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(fixture.repository.attempts.get('old')?.state).toBe('detached');
    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it('preserves a candidate when its generation retires before the locked revalidation', async () => {
    const fixture = makeFixture();
    fixture.addCandidate('old', 'motion_video', NOW - 91 * DAY_MS);
    fixture.lock.beforeOperation = () => { fixture.credentials.active = null; };

    await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it('preserves a candidate that becomes busy before the locked revalidation', async () => {
    const fixture = makeFixture();
    fixture.addCandidate('old', 'motion_video', NOW - 91 * DAY_MS);
    fixture.lock.beforeOperation = () => {
      fixture.repository.attempts.set('old', {
        ...fixture.repository.attempts.get('old')!,
        state: 'uploading',
      });
    };

    await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it('preserves a young video when its verified local master disappears before lock admission', async () => {
    const fixture = makeFixture();
    fixture.addCandidate('young-local', 'motion_video', NOW - DAY_MS, true);
    fixture.lock.beforeOperation = () => {
      fixture.source.paths.delete('/archive/young-local');
    };

    await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(fixture.drive.deletedIds).toEqual([]);
  });

  it('reloads the exact ID immediately before permanent deletion under the short cleanup lock', async () => {
    const calls: string[] = [];
    const fixture = makeFixture({ calls });
    fixture.addCandidate('old', 'motion_video', NOW - 91 * DAY_MS);

    await fixture.useCase.execute({ requiredBytes: 5 }, signal);

    expect(calls).toEqual([
      'load-active',
      'list:database_backup',
      'list:motion_video',
      'load-artifact:artifact-old',
      'cleanup-lock',
      'remote-lock',
      'load-active',
      'load-attempt:old',
      'load-artifact:artifact-old',
      'load-object:old',
      'delete-exact:old',
      'mark-deleted:old',
    ]);
  });
});

function makeFixture(options: {
  quota?: Partial<Quota>;
  accounting?: DriveQuotaReclamationState;
  lastUploadSuccessMs?: number | null;
  calls?: string[];
  candidateLimit?: number;
} = {}) {
  const calls = options.calls ?? [];
  const repository = new RetentionRepositoryFake(calls, options.lastUploadSuccessMs ?? null);
  const credentials = new CredentialRepositoryFake(calls, options.accounting);
  const drive = new DriveFake(calls);
  const clock = new ClockFake();
  const source = new SourceFake();
  const lock = new CleanupLockFake(calls);
  const quota: Quota = {
    limitBytes: 100,
    usageBytes: 100,
    usageInDriveBytes: 90,
    usageInDriveTrashBytes: 0,
    ...options.quota,
  };
  const useCase = new ApplyDriveRetentionUseCase(
    repository,
    credentials,
    { readQuota: async () => quota },
    drive,
    source,
    clock,
    lock,
    { candidateLimit: options.candidateLimit ?? 100 },
  );

  return {
    useCase,
    repository,
    credentials,
    drive,
    clock,
    source,
    lock,
    addCandidate(
      id: string,
      kind: 'motion_video' | 'database_backup',
      providerCreatedAtMs: number,
      local = false,
    ) {
      const artifact = artifactFixture(id, kind);
      const remote = remoteFixture(id, artifact, providerCreatedAtMs);
      repository.artifacts.set(artifact.id, artifact);
      repository.attempts.set(id, attemptFixture(id, artifact, remote));
      drive.objects.set(id, remote);
      if (local) source.paths.add(artifact.trustedPath);
    },
  };
}

interface Quota {
  limitBytes: number | null;
  usageBytes: number;
  usageInDriveBytes: number;
  usageInDriveTrashBytes: number;
}

class ClockFake implements ArchiveClockPort {
  reading = { nowMs: NOW, synchronized: true, plausible: true, offsetMs: 0 };
  async read() { return this.reading; }
}

class RetentionRepositoryFake {
  readonly artifacts = new Map<string, ArchiveArtifact>();
  readonly attempts = new Map<string, ArchiveObjectAttempt>();
  readonly scheduler: ArchiveSchedulerState;

  constructor(private readonly calls: string[], lastUploadSuccessMs: number | null) {
    this.scheduler = {
      revision: 0,
      backupLeaseOwner: null,
      backupLeaseExpiresAtMs: null,
      lastBackupSuccessMs: null,
      lastUploadSuccessMs,
      lastReconcileSuccessMs: null,
      lastCleanupSuccessMs: null,
    };
  }

  async listRetentionCandidates(selection: RetentionSelection) {
    this.calls.push(`list:${selection.kind}`);
    return [...this.attempts.values()]
      .filter((attempt) => this.artifacts.get(attempt.artifactId)?.kind === selection.kind)
      .filter((attempt) =>
        selection.generationId === undefined || attempt.generationId === selection.generationId,
      )
      .sort((left, right) =>
        (left.verifiedObject?.providerCreatedAtMs ?? 0) -
          (right.verifiedObject?.providerCreatedAtMs ?? 0),
      )
      .slice(0, selection.limit);
  }

  async loadAttempt(id: string) {
    this.calls.push(`load-attempt:${id}`);
    return this.attempts.get(id) ?? null;
  }

  async loadArtifact(id: string) {
    this.calls.push(`load-artifact:${id}`);
    return this.artifacts.get(id) ?? null;
  }

  async markDetached(id: string, expectedRevision: number, reason: string, nowMs: number) {
    const attempt = this.attempts.get(id);
    if (attempt?.revision !== expectedRevision) throw new Error('attempt changed');
    this.attempts.set(id, {
      ...attempt,
      state: 'detached',
      revision: expectedRevision + 1,
      detachedReason: reason,
      updatedAtMs: nowMs,
    });
  }

  async markDeleted(id: string, expectedRevision: number, nowMs: number) {
    this.calls.push(`mark-deleted:${id}`);
    const attempt = this.attempts.get(id);
    if (attempt?.revision !== expectedRevision) throw new Error('attempt changed');
    this.attempts.set(id, {
      ...attempt,
      state: 'deleted',
      revision: expectedRevision + 1,
      deletedAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  async readSchedulerState() { return this.scheduler; }
}

class CredentialRepositoryFake {
  active = activeConnection();
  accounting: DriveQuotaReclamationState;

  constructor(
    private readonly calls: string[],
    accounting: DriveQuotaReclamationState = { windowStartedMs: null, reclaimedBytes: 0 },
  ) {
    this.accounting = { ...accounting };
  }

  async loadActive() {
    this.calls.push('load-active');
    return this.active;
  }

  async readQuotaReclamation() { return { ...this.accounting }; }

  async compareAndSetQuotaReclamation(input: {
    expected: DriveQuotaReclamationState;
    next: DriveQuotaReclamationState;
  }) {
    if (
      this.accounting.windowStartedMs !== input.expected.windowStartedMs ||
      this.accounting.reclaimedBytes !== input.expected.reclaimedBytes
    ) return false;
    this.accounting = { ...input.next };
    return true;
  }
}

class DriveFake {
  readonly objects = new Map<string, VerifiedDriveObject>();
  readonly deletedIds: string[] = [];

  constructor(private readonly calls: string[]) {}

  async loadObject(_connection: DriveConnection, id: string) {
    this.calls.push(`load-object:${id}`);
    return this.objects.get(id) ?? null;
  }

  async deleteExact(_connection: DriveConnection, id: string) {
    this.calls.push(`delete-exact:${id}`);
    this.deletedIds.push(id);
    this.objects.delete(id);
  }
}

class SourceFake {
  readonly paths = new Set<string>();

  async stat(path: string) {
    if (!this.paths.has(path)) throw new Error('ENOENT');
    return { size: LOCAL_BYTES.byteLength, mtimeNs: '500000000' };
  }

  async *open(path: string) {
    if (!this.paths.has(path)) throw new Error('ENOENT');
    yield LOCAL_BYTES;
  }
}

class CleanupLockFake {
  beforeOperation: (() => void) | null = null;

  constructor(private readonly calls: string[]) {}

  async tryRunCleanup<T>(operation: () => Promise<T>): Promise<T | null> {
    this.calls.push('cleanup-lock');
    this.beforeOperation?.();
    this.beforeOperation = null;
    return operation();
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.calls.push('remote-lock');
    return operation();
  }
}

function activeConnection() {
  return DriveConnection.restore({
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

function artifactFixture(id: string, kind: 'motion_video' | 'database_backup') {
  const relativePath = kind === 'motion_video'
    ? `2029/12/31/120000-${id}.mp4`
    : id;
  return ArchiveArtifact.restore({
    id: `artifact-${id}`,
    installationId: 'installation-1',
    kind,
    sourceIdentity: `${kind}:${id}`,
    trustedPath: `/archive/${id}`,
    relativePath,
    size: LOCAL_BYTES.byteLength,
    mtimeNs: '500000000',
    sourceTimeMs: NOW - DAY_MS,
    sha256: DIGEST,
    sourceFingerprint: createHash('sha256').update(id).digest('hex'),
    state: 'verified',
    currentVerifiedAttemptId: id,
    createdAtMs: NOW - DAY_MS,
    updatedAtMs: NOW - DAY_MS,
    localDeletedAtMs: null,
    revision: 1,
  });
}

function remoteFixture(
  id: string,
  artifact: ArchiveArtifact,
  createdTimeMs: number,
): VerifiedDriveObject {
  return {
    id,
    name: artifact.kind === 'motion_video'
      ? artifact.relativePath.split('/').at(-1)!
      : artifact.relativePath,
    parentId: artifact.kind === 'database_backup' ? 'backups-1' : 'motion-1',
    mimeType: artifact.kind === 'database_backup' ? 'application/vnd.sqlite3' : 'video/mp4',
    size: artifact.size,
    sha256: artifact.sha256,
    md5: 'c'.repeat(32),
    createdTimeMs,
    headRevisionId: `revision-${id}`,
    version: '1',
    ownedByMe: true,
    canDelete: true,
    trashed: false,
    appProperties: encodeArchiveAppProperties({
      installationId: artifact.installationId,
      generationId: 'generation-1',
      kind: artifact.kind,
      sourceFingerprint: artifact.sourceFingerprint,
      sha256: artifact.sha256,
      sourceTimeMs: artifact.sourceTimeMs,
      schemaVersion: 1,
    }),
    sharing: {
      ownerPermissionId: 'owner-1',
      shared: false,
      permissionIds: ['owner-1'],
    },
    webViewLink: null,
  };
}

function attemptFixture(
  id: string,
  artifact: ArchiveArtifact,
  remote: VerifiedDriveObject,
): ArchiveObjectAttempt {
  return {
    id,
    artifactId: artifact.id,
    generationId: 'generation-1',
    remoteObjectId: id,
    containerId: remote.parentId,
    state: 'verified',
    createdAtMs: remote.createdTimeMs,
    updatedAtMs: remote.createdTimeMs,
    uploadedAtMs: remote.createdTimeMs,
    verifiedAtMs: remote.createdTimeMs,
    deletedAtMs: null,
    revision: 1,
    nextAttemptMs: remote.createdTimeMs,
    retryCount: 0,
    errorCode: null,
    detachedReason: null,
    missingReason: null,
    session: null,
    verifiedObject: {
      objectId: remote.id,
      name: remote.name,
      containerId: remote.parentId,
      contentType: remote.mimeType,
      size: remote.size,
      sha256: remote.sha256,
      md5: remote.md5,
      providerCreatedAtMs: remote.createdTimeMs,
      revisionId: remote.headRevisionId,
      version: remote.version,
      ownedByInstallation: remote.ownedByMe,
      canDelete: remote.canDelete,
      trashed: remote.trashed,
      attributes: remote.appProperties,
      sharing: remote.sharing,
      webViewLink: remote.webViewLink,
    },
  };
}
