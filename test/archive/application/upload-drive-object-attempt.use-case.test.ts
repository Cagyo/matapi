import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ArchiveSecretCipherPort, ArchiveSecretEnvelope } from '../../../src/archive/application/ports/archive-secret-cipher.port';
import type { DriveArchivePort, UploadChunk } from '../../../src/archive/application/ports/drive-archive.port';
import { ArchiveTransferSemaphoreService } from '../../../src/archive/application/archive-transfer-semaphore.service';
import {
  UploadDriveObjectAttemptUseCase,
  type ArchiveUploadSourcePort,
} from '../../../src/archive/application/use-cases/upload-drive-object-attempt.use-case';
import { InMemoryArchiveArtifactRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-artifact.repository';
import { DriveConnection } from '../../../src/archive/domain/drive-connection.entity';
import type { VerifiedDriveObject } from '../../../src/archive/domain/drive-object-metadata.value-object';
import { DriveAttemptLeaseLostError } from '../../../src/archive/domain/errors/drive-attempt-lease-lost.error';
import { DriveFolderBranchBlockedError } from '../../../src/archive/domain/errors/drive-folder-branch-blocked.error';
import { DriveObjectDetachedError } from '../../../src/archive/domain/errors/drive-object-detached.error';
import { DriveRateLimitedError } from '../../../src/archive/domain/errors/drive-rate-limited.error';
import { DriveTemporaryUnavailableError } from '../../../src/archive/domain/errors/drive-temporary-unavailable.error';
import { ArchiveProviderGateService } from '../../../src/archive/application/archive-provider-gate.service';
import { InMemoryArchiveProviderStateRepository } from '../../../src/archive/infrastructure/persistence/in-memory-archive-provider-state.repository';

const now = 1_000_000;
const bytes = Buffer.alloc(700_000, 7);
const digest = createHash('sha256').update(bytes).digest('hex');
const signal = new AbortController().signal;

describe('UploadDriveObjectAttemptUseCase', () => {
  it.each([
    ['avi', 'video/x-msvideo'],
    ['mkv', 'video/x-matroska'],
    ['mp4', 'video/mp4'],
  ])('uploads %s under the verified day folder with %s', async (extension, mimeType) => {
    const fixture = await setup({ relativePath: `2026/08/13/120000-event.${extension}` });

    await fixture.useCase.execute(fixture.artifactId, signal);

    expect(fixture.resolver.execute).toHaveBeenCalled();
    expect(fixture.drive.beginInputs.at(-1)).toMatchObject({
      parentId: 'day-folder-1',
      mimeType,
    });
  });

  it('revalidates the full folder chain before resuming a nested attempt', async () => {
    const fixture = await setup({
      createAttempt: true,
      relativePath: '2026/08/13/120000-event.mp4',
      attemptContainerId: 'day-folder-1',
    });
    await fixture.seedSession(0);

    await fixture.useCase.execute(fixture.attemptId(), signal);

    expect(fixture.journal.indexOf('resolve-folder'))
      .toBeLessThan(fixture.journal.indexOf('query-session'));
  });

  it.each(['year', 'month', 'day'] as const)(
    'refuses verification when the %s folder changes after the final chunk',
    async (level) => {
      const fixture = await setup();
      const markVerified = vi.spyOn(fixture.repository, 'markVerified');
      const mutation = folderMutationFor(level);
      fixture.resolver.execute
        .mockResolvedValueOnce('day-folder-1')
        .mockRejectedValueOnce(mutation);

      await expect(fixture.useCase.execute(fixture.artifactId, signal))
        .rejects.toMatchObject({
          code: 'DRIVE_FOLDER_BRANCH_BLOCKED', message: mutation.message, mutationLevel: level,
        });

      expect(fixture.drive.uploadCalls).toBeGreaterThan(0);
      expect(markVerified).not.toHaveBeenCalled();
      await expectExactRetryableAttempt(fixture, 'day-folder-1');
    },
  );

  it('refuses verification when final resolution returns a replacement leaf', async () => {
    const fixture = await setup();
    const markVerified = vi.spyOn(fixture.repository, 'markVerified');
    fixture.resolver.execute
      .mockResolvedValueOnce('historical-day-id')
      .mockResolvedValueOnce('replacement-day-id');

    await expect(fixture.useCase.execute(fixture.artifactId, signal))
      .rejects.toBeInstanceOf(DriveObjectDetachedError);

    expect(markVerified).not.toHaveBeenCalled();
    await expectExactRetryableAttempt(fixture, 'historical-day-id');
  });

  it('reconciles the old exact ID and atomically reserves a replacement when the leaf changed', async () => {
    const fixture = await setup({
      createAttempt: true,
      relativePath: '2026/08/13/120000-event.mp4',
      attemptContainerId: 'old-day-folder',
    });
    await fixture.seedSession(0);
    fixture.drive.generatedIds.push('reserved-2');
    fixture.resolver.execute.mockResolvedValue('new-day-folder');
    fixture.drive.queryResult = { kind: 'expired' };

    await expect(fixture.useCase.execute(fixture.attemptId(), signal)).resolves.toMatchObject({
      kind: 'replaced',
      replacementFileId: 'reserved-2',
    });

    const attempts = await fixture.repository.listAttempts(fixture.artifactId);
    expect(attempts.map((attempt) => [attempt.containerId, attempt.state])).toEqual([
      ['old-day-folder', 'missing'],
      ['new-day-folder', 'pending'],
    ]);
  });

  it('keeps a surviving old exact object schedulable for reconciliation when the leaf changed', async () => {
    const fixture = await setup({
      createAttempt: true,
      relativePath: '2026/08/13/120000-event.mp4',
      attemptContainerId: 'old-day-folder',
    });
    await fixture.seedSession(0);
    fixture.resolver.execute.mockResolvedValue('new-day-folder');
    fixture.drive.queryResult = { kind: 'expired' };
    fixture.drive.objects.set('reserved-1', verified(
      'reserved-1', bytes, {}, '120000-event.mp4', 'old-day-folder', 'video/mp4',
    ));

    await expect(fixture.useCase.execute(fixture.attemptId(), signal))
      .rejects.toBeInstanceOf(DriveObjectDetachedError);

    expect(await fixture.repository.listAttempts(fixture.artifactId)).toMatchObject([
      { remoteObjectId: 'reserved-1', containerId: 'old-day-folder', state: 'retryable' },
    ]);
  });

  it('uses the renewed lease when a non-exact old object needs a new-container replacement', async () => {
    const fixture = await setup({
      createAttempt: true,
      leaseMs: 500,
      relativePath: '2026/08/13/120000-event.mp4',
      attemptContainerId: 'old-day-folder',
    });
    fixture.drive.generatedIds.push('reserved-2');
    fixture.resolver.execute.mockResolvedValue('new-day-folder');
    fixture.drive.objects.set('reserved-1', verified(
      'reserved-1', bytes, { sha256: '0'.repeat(64) },
      '120000-event.mp4', 'old-day-folder', 'video/mp4',
    ));
    fixture.source.onYield = () => { fixture.clock.value += 200; };

    await expect(fixture.useCase.execute(fixture.attemptId(), signal)).resolves.toMatchObject({
      kind: 'replaced', replacementFileId: 'reserved-2',
    });

    expect(await fixture.repository.listAttempts(fixture.artifactId)).toMatchObject([
      { containerId: 'old-day-folder', state: 'detached' },
      { containerId: 'new-day-folder', state: 'pending' },
    ]);
  });

  it('terminalizes an invalid motion path before generating a Drive file ID', async () => {
    const fixture = await setup({ relativePath: 'clip.mp4' });

    await expect(fixture.useCase.execute(fixture.artifactId, signal)).rejects.toThrow(/path/iu);

    expect(fixture.drive.generateCalls).toBe(0);
    expect(await fixture.repository.loadArtifact(fixture.artifactId)).toMatchObject({
      admission: { state: 'terminal', errorCode: 'invalid_motion_path' },
    });
  });

  it('makes a temporary pre-attempt file-ID failure retryable without creating an attempt', async () => {
    const fixture = await setup();
    fixture.drive.generateError = new Error('temporary provider failure');

    await expect(fixture.useCase.execute(fixture.artifactId, signal))
      .rejects.toThrow('temporary provider failure');

    expect(await fixture.repository.loadArtifact(fixture.artifactId)).toMatchObject({
      admission: {
        state: 'retryable', errorCode: 'temporary_failure', nextAttemptMs: now + 1_000,
      },
    });
    expect(await fixture.repository.listAttempts(fixture.artifactId)).toEqual([]);
  });

  it('persists provider admission when reserved-ID generation is rate limited', async () => {
    const fixture = await setup({ providerGate: true });
    fixture.drive.generateError = providerRateLimit('metadata');

    await expect(fixture.useCase.execute(fixture.artifactId, signal))
      .rejects.toBeInstanceOf(DriveRateLimitedError);

    await expect(fixture.providerState.load()).resolves.toMatchObject({
      generationId: 'generation-1',
      operationClass: 'upload',
      failureClass: 'rate-limit',
      cooldownUntilMs: now + 60_000,
    });
  });

  it('persists provider admission when exact-ID reconciliation is rate limited', async () => {
    const fixture = await setup({ createAttempt: true, providerGate: true });
    fixture.drive.loadError = providerRateLimit('metadata');

    await expect(fixture.useCase.execute(fixture.attemptId(), signal))
      .rejects.toBeInstanceOf(DriveRateLimitedError);

    await expect(fixture.providerState.load()).resolves.toMatchObject({
      generationId: 'generation-1',
      operationClass: 'upload',
      failureClass: 'rate-limit',
      cooldownUntilMs: now + 60_000,
    });
  });

  it('persists provider admission when changed-container session reconciliation is rate limited', async () => {
    const fixture = await setup({
      createAttempt: true,
      providerGate: true,
      attemptContainerId: 'old-day-folder',
    });
    await fixture.seedSession(0);
    fixture.resolver.execute.mockResolvedValue('new-day-folder');
    fixture.drive.queryError = providerRateLimit('session-query');

    await expect(fixture.useCase.execute(fixture.attemptId(), signal))
      .rejects.toBeInstanceOf(DriveRateLimitedError);

    await expect(fixture.providerState.load()).resolves.toMatchObject({
      generationId: 'generation-1',
      operationClass: 'upload',
      failureClass: 'rate-limit',
      cooldownUntilMs: fixture.clock.value + 60_000,
    });
  });

  it('persists provider admission when conflict replacement-ID generation is rate limited', async () => {
    const fixture = await setup({ providerGate: true });
    fixture.drive.conflictOnBegin = true;
    fixture.drive.onBegin = async () => {
      fixture.drive.generateError = providerRateLimit('metadata');
    };

    await expect(fixture.useCase.execute(fixture.artifactId, signal))
      .rejects.toBeInstanceOf(DriveRateLimitedError);

    await expect(fixture.providerState.load()).resolves.toMatchObject({
      generationId: 'generation-1',
      operationClass: 'upload',
      failureClass: 'rate-limit',
      cooldownUntilMs: fixture.clock.value + 60_000,
    });
  });

  it('keeps the retry fence current across replacement-ID provider waits', async () => {
    const fixture = await setup({ providerGate: true });
    fixture.drive.conflictOnBegin = true;
    fixture.drive.onBegin = async () => {
      fixture.drive.generateError = new DriveTemporaryUnavailableError('replacement unavailable');
    };

    await expect(fixture.useCase.execute(fixture.artifactId, signal))
      .rejects.toThrow('replacement unavailable');

    expect(fixture.providerSleeps.length).toBeGreaterThan(0);
    expect((await fixture.repository.listAttempts(fixture.artifactId))[0]).toMatchObject({
      state: 'retryable',
      errorCode: 'temporary_failure',
    });
  });

  it('reports the exact selected generation before a provider failure escapes', async () => {
    const fixture = await setup();
    fixture.drive.generateError = new Error('temporary provider failure');
    const selected: string[] = [];

    await expect(fixture.useCase.execute(
      fixture.artifactId,
      signal,
      (generationId) => selected.push(generationId),
    )).rejects.toThrow('temporary provider failure');

    expect(selected).toEqual(['generation-1']);
  });

  it.each([
    ['changed', 'local_source_changed'],
    ['missing', 'local_source_missing'],
  ] as const)('terminalizes only the %s local source and abandons its exact attempt', async (failure, errorCode) => {
    const fixture = await setup({ createAttempt: true });
    await fixture.seedSession(0);
    if (failure === 'changed') fixture.source.statOverride = { size: bytes.length + 1, mtimeNs: '123' };
    else fixture.source.statError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const healthy = await fixture.repository.register({
      installationId: 'installation-1', kind: 'motion_video', sourceIdentity: 'motion:healthy',
      trustedPath: '/motion/healthy.mp4', relativePath: '2026/08/14/120000-healthy.mp4',
      size: bytes.length, mtimeNs: '123', sourceTimeMs: now - 900,
      sha256: digest, sourceFingerprint: 'e'.repeat(64),
    });

    await expect(fixture.useCase.execute(fixture.attemptId(), signal)).rejects.toThrow();

    expect(await fixture.repository.loadAttempt(fixture.attemptId())).toMatchObject({
      state: 'abandoned', session: null, errorCode,
    });
    expect(await fixture.repository.loadArtifact(fixture.artifactId)).toMatchObject({
      admission: { state: 'terminal', errorCode },
    });
    expect(await fixture.repository.listUnattemptedArtifacts({
      kind: 'motion_video', generationId: 'generation-1', nowMs: now, limit: 10,
    })).toMatchObject([{ id: healthy.id }]);
  });

  it.each([
    ['short read', 'short', 'local_source_changed'],
    ['long read', 'long', 'local_source_changed'],
    ['digest mutation', 'corrupt', 'local_source_changed'],
    ['final stat mutation', 'final-stat', 'local_source_changed'],
    ['disappearance while streaming', 'missing', 'local_source_missing'],
  ] as const)(
    'terminalizes a Motion attempt after %s instead of returning it to the retry queue',
    async (_label, failure, errorCode) => {
      const fixture = await setup();
      fixture.source.readFailure = failure;
      fixture.drive.acceptInvalidBodyLength = failure === 'short' || failure === 'long';

      await expect(fixture.useCase.execute(fixture.artifactId, signal)).rejects.toThrow();

      const [attempt] = await fixture.repository.listAttempts(fixture.artifactId);
      expect(await fixture.repository.loadArtifact(fixture.artifactId)).toMatchObject({
        admission: { state: 'terminal', errorCode },
      });
      expect(attempt).toMatchObject({
        state: 'abandoned', session: null, errorCode,
      });
      expect(await fixture.repository.claimNextAttempt({
        owner: 'retry-worker', nowMs: fixture.clock.value + 10_000, leaseMs: 1_000,
      })).toBeNull();
    },
  );

  it('keeps database backups directly under the managed Backups folder', async () => {
    const fixture = await setup({ kind: 'database_backup', relativePath: 'backups/home-worker.sqlite3' });

    await fixture.useCase.execute(fixture.artifactId, signal);

    expect(fixture.resolver.execute).not.toHaveBeenCalled();
    expect(fixture.drive.beginInputs.at(-1)).toMatchObject({
      parentId: 'backup-folder',
      name: 'home-worker.sqlite3',
      mimeType: 'application/vnd.sqlite3',
    });
  });

  it('persists a generated ID and encrypted session before sending bounded chunks', async () => {
    const fixture = await setup();
    const events: string[] = [];
    fixture.drive.onGenerate = () => events.push('generated');
    fixture.drive.onBegin = async () => {
      const attempts = await fixture.repository.listAttempts(fixture.artifactId);
      events.push(`begin:${attempts[0]?.remoteObjectId}`);
    };
    fixture.drive.onChunk = async () => {
      const attempts = await fixture.repository.listAttempts(fixture.artifactId);
      events.push(`chunk:${attempts[0]?.session?.ciphertext ? 'encrypted' : 'plain'}`);
    };

    const result = await fixture.useCase.execute(fixture.artifactId, signal);

    expect(result.kind).toBe('verified');
    expect(events).toEqual(['generated', 'begin:reserved-1', 'chunk:encrypted', 'chunk:encrypted', 'chunk:encrypted']);
    expect(fixture.source.maxRequestedBytes).toBeLessThanOrEqual(256 * 1024);
    const attempts = await fixture.repository.listAttempts(fixture.artifactId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe('verified');
  });

  it('uses the server offset rather than the locally persisted offset and hashes the local prefix', async () => {
    const fixture = await setup({ createAttempt: true });
    const attempt = (await fixture.repository.listAttempts(fixture.artifactId))[0];
    const claim = await fixture.repository.claimAttempt(attempt.id, { owner: 'seed', nowMs: now, leaseMs: 10 });
    const envelope = await fixture.cipher.encrypt(Buffer.from(fixture.drive.session.uri), {
      installationId: 'installation-1', rowId: attempt.id, kind: 'upload-session', schemaVersion: 1,
    });
    await fixture.repository.saveSession(attempt.id, claim.lease, {
      ciphertext: envelope.ciphertext, nonce: envelope.iv, authTag: envelope.authTag, keyVersion: envelope.version,
      formatVersion: 1, createdAtMs: now - 100, expiresAtMs: now + 100_000, confirmedOffset: 786_432,
    }, now);
    fixture.clock.value = now + 11;
    fixture.drive.queryResult = { kind: 'resume', confirmedOffset: 262_144 };

    await fixture.useCase.execute(attempt.id, signal);

    expect(fixture.source.openStarts[0]).toBe(0);
    expect(fixture.source.openEnds[0]).toBe(262_144);
    expect(fixture.source.openStarts[1]).toBe(262_144);
  });

  it('resumes durable session state after a process restart without creating another attempt', async () => {
    const fixture = await setup();
    fixture.drive.failChunkOnce = true;
    await expect(fixture.useCase.execute(fixture.artifactId, signal)).rejects.toThrow('network');
    const attempt = (await fixture.repository.listAttempts(fixture.artifactId))[0];
    expect(attempt.session?.ciphertext).toBeTruthy();
    fixture.clock.value += 1_001;

    const restarted = fixture.newUseCase();
    await restarted.execute(attempt.id, signal);

    expect(fixture.drive.beginCalls).toBe(1);
    expect(await fixture.repository.listAttempts(fixture.artifactId)).toHaveLength(1);
  });

  it('reopens bytes from the confirmed offset for each bounded inline retry', async () => {
    const fixture = await setup({ providerGate: true });
    fixture.drive.failChunkAfterConsumeOnce = true;

    await fixture.useCase.execute(fixture.artifactId, signal);

    expect(fixture.source.openStarts.filter((start) => start === 0)).toHaveLength(2);
    expect(fixture.drive.queryCalls).toBe(1);
    expect(fixture.providerSleeps).toEqual([1_500]);
  });

  it('clears an unusable session after a session-phase rate limit before rescheduling', async () => {
    const fixture = await setup({ createAttempt: true });
    await fixture.seedSession(0);
    fixture.drive.queryError = new DriveRateLimitedError({
      retryAfterMs: 60_000,
      sessionUsable: false,
      operationPhase: 'session-query',
    });

    await expect(fixture.useCase.execute(fixture.attemptId(), signal))
      .rejects.toBeInstanceOf(DriveRateLimitedError);

    expect(await fixture.repository.loadAttempt(fixture.attemptId())).toMatchObject({
      state: 'retryable', session: null,
    });
    expect(fixture.drive.loadIds).toContain('reserved-1');
  });

  it('verifies a timed-out creation by its reserved ID without duplicating', async () => {
    const fixture = await setup();
    fixture.drive.failAfterRemoteCreate = true;

    await fixture.useCase.execute(fixture.artifactId, signal);

    expect(await fixture.repository.listAttempts(fixture.artifactId)).toHaveLength(1);
    expect(fixture.drive.loadIds).toContain('reserved-1');
  });

  it('atomically replaces a reserved ID when ambiguous creation finds mismatching metadata', async () => {
    const fixture = await setup();
    fixture.drive.generatedIds.push('reserved-2');
    fixture.drive.remoteOverride = { sha256: '0'.repeat(64) };
    fixture.drive.failAfterRemoteCreate = true;

    await expect(fixture.useCase.execute(fixture.artifactId, signal)).resolves.toEqual(expect.objectContaining({
      kind: 'replaced', replacementFileId: 'reserved-2',
    }));

    expect((await fixture.repository.listAttempts(fixture.artifactId)).map((attempt) => [attempt.remoteObjectId, attempt.state]))
      .toEqual(expect.arrayContaining([['reserved-1', 'conflict'], ['reserved-2', 'pending']]));
  });

  it('preserves a conflicting reserved ID and reserves a new ID in a new row', async () => {
    const fixture = await setup();
    fixture.drive.generatedIds.push('reserved-2');
    fixture.drive.conflictOnBegin = true;

    await expect(fixture.useCase.execute(fixture.artifactId, signal)).resolves.toEqual(expect.objectContaining({ kind: 'replaced' }));

    const attempts = await fixture.repository.listAttempts(fixture.artifactId);
    expect(attempts.map((attempt) => [attempt.remoteObjectId, attempt.state])).toEqual(expect.arrayContaining([
      ['reserved-1', 'conflict'], ['reserved-2', 'pending'],
    ]));
  });

  it('restarts an expired provider session with the same immutable reserved ID when it remains free', async () => {
    const fixture = await setup({ createAttempt: true });
    await fixture.seedSession(0);
    fixture.drive.queryResult = { kind: 'expired' };

    await fixture.useCase.execute(fixture.attemptId(), signal);

    expect(fixture.drive.beginFileIds).toEqual(['reserved-1']);
    expect(await fixture.repository.listAttempts(fixture.artifactId)).toHaveLength(1);
  });

  it.each([
    ['source mutation', (fixture: Awaited<ReturnType<typeof setup>>) => { fixture.source.mutateAfterRead = true; }],
    ['Drive checksum mismatch', (fixture: Awaited<ReturnType<typeof setup>>) => { fixture.drive.remoteOverride = { sha256: '0'.repeat(64) }; }],
    ['missing binary revision', (fixture: Awaited<ReturnType<typeof setup>>) => { fixture.drive.remoteOverride = { headRevisionId: '' }; }],
    ['owner permission from another account', (fixture: Awaited<ReturnType<typeof setup>>) => {
      fixture.drive.remoteOverride = {
        sharing: { ownerPermissionId: 'owner-2', shared: false, permissionIds: ['owner-2'] },
      };
    }],
  ])('refuses atomic verification for %s', async (_name, arrange) => {
    const fixture = await setup();
    arrange(fixture);

    await expect(fixture.useCase.execute(fixture.artifactId, signal)).rejects.toThrow();

    expect((await fixture.repository.listAttempts(fixture.artifactId))[0].state).not.toBe('verified');
  });

  it('honors cancellation while waiting for the one transfer slot', async () => {
    const fixture = await setup();
    const release = await fixture.semaphore.acquire('database_backup', signal);
    const controller = new AbortController();
    const execution = fixture.useCase.execute(fixture.artifactId, controller.signal);
    controller.abort(new Error('cancelled'));

    await expect(execution).rejects.toThrow('cancelled');
    release();
    expect(fixture.drive.beginCalls).toBe(0);
  });

  it('rejects a stale exact-attempt lease instead of uploading concurrently', async () => {
    const fixture = await setup({ createAttempt: true });
    await fixture.repository.claimAttempt(fixture.attemptId(), { owner: 'other', nowMs: now, leaseMs: 10_000 });

    await expect(fixture.useCase.execute(fixture.attemptId(), signal)).rejects.toThrow('lease');
    expect(fixture.drive.beginCalls).toBe(0);
  });

  it('renews the fenced lease while hashing a resumed local prefix', async () => {
    const fixture = await setup({ createAttempt: true, leaseMs: 500 });
    await fixture.seedSession(786_432);
    fixture.drive.queryResult = { kind: 'resume', confirmedOffset: 262_144 };
    fixture.source.onYield = (start) => { if (start === 0) fixture.clock.value += 200; };
    const renew = vi.spyOn(fixture.repository, 'renewLease');

    await fixture.useCase.execute(fixture.attemptId(), signal);

    expect(renew.mock.calls.length).toBeGreaterThan(3);
    expect(fixture.drive.uploadCalls).toBeGreaterThan(0);
  });

  it('renews the fenced lease throughout a full verification hash', async () => {
    const fixture = await setup({ leaseMs: 500 });
    fixture.drive.failAfterRemoteCreate = true;
    fixture.source.onYield = () => { fixture.clock.value += 200; };
    const renew = vi.spyOn(fixture.repository, 'renewLease');

    await fixture.useCase.execute(fixture.artifactId, signal);

    expect(renew.mock.calls.length).toBeGreaterThan(3);
  });

  it('stops before upload when lease renewal fails during prefix hashing', async () => {
    const fixture = await setup({ createAttempt: true, leaseMs: 500 });
    await fixture.seedSession(786_432);
    fixture.drive.queryResult = { kind: 'resume', confirmedOffset: 262_144 };
    fixture.source.onYield = (start) => { if (start === 0) fixture.clock.value += 200; };
    const originalRenew = fixture.repository.renewLease.bind(fixture.repository);
    vi.spyOn(fixture.repository, 'renewLease')
      .mockImplementationOnce(originalRenew)
      .mockRejectedValueOnce(new DriveAttemptLeaseLostError('lease renewal failed'));

    await expect(fixture.useCase.execute(fixture.attemptId(), signal)).rejects.toThrow('lease renewal failed');

    expect(fixture.drive.uploadCalls).toBe(0);
    expect(await fixture.repository.loadAttempt(fixture.attemptId())).toMatchObject({ state: 'uploading' });
  });
});

async function setup(options: {
  createAttempt?: boolean;
  leaseMs?: number;
  relativePath?: string;
  attemptContainerId?: string;
  kind?: 'motion_video' | 'database_backup';
  providerGate?: boolean;
} = {}) {
  const repository = new InMemoryArchiveArtifactRepository();
  const relativePath = options.relativePath ?? '2026/08/13/120000-clip.mp4';
  const kind = options.kind ?? 'motion_video';
  const artifact = await repository.register({
    installationId: 'installation-1', kind, sourceIdentity: `${kind}:clip`, trustedPath: '/motion/clip.mp4',
    relativePath, size: bytes.length, mtimeNs: '123', sourceTimeMs: now - 1_000,
    sha256: digest, sourceFingerprint: 'f'.repeat(64),
  });
  const existingAttempt = options.createAttempt
    ? await repository.createAttempt(
      artifact.id, 'generation-1', 'reserved-1', options.attemptContainerId ?? 'day-folder-1', now - 20,
    )
    : null;
  const connection = DriveConnection.stage({ id: 'generation-1', installationId: 'installation-1', nowMs: 1 }).activate({
    permissionId: 'owner-1', email: null, displayName: null,
    folders: { rootId: 'root-folder', motionId: 'motion-folder', backupsId: 'backup-folder' }, nowMs: 2,
  });
  const source = new FakeSource(bytes);
  const journal: string[] = [];
  const drive = new FakeDrive(bytes, journal);
  drive.fallbackName = relativePath.split('/').at(-1) ?? '';
  drive.fallbackParentId = existingAttempt?.containerId
    ?? (kind === 'database_backup' ? 'backup-folder' : 'day-folder-1');
  drive.fallbackMimeType = kind === 'database_backup'
    ? 'application/vnd.sqlite3'
    : relativePath.endsWith('.avi') ? 'video/x-msvideo'
      : relativePath.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4';
  drive.artifactKind = kind;
  if (existingAttempt !== null) drive.generatedIds.shift();
  drive.lastAttemptId = existingAttempt?.id ?? null;
  const resolver = {
    execute: vi.fn(async () => {
      journal.push('resolve-folder');
      return 'day-folder-1';
    }),
  };
  const cipher = new FakeCipher();
  const semaphore = new ArchiveTransferSemaphoreService();
  const clock = { value: now, now() { return this.value; } };
  const providerSleeps: number[] = [];
  const providerState = new InMemoryArchiveProviderStateRepository();
  const providerGate = options.providerGate
    ? new ArchiveProviderGateService(
      providerState,
      { now: () => new Date(clock.value) },
      { sleep: async (ms: number) => { providerSleeps.push(ms); clock.value += ms; } },
      { random: () => 0.5 },
    )
    : undefined;
  if (providerGate !== undefined) await providerGate.ensureGeneration(connection.id);
  const credentials = { loadActive: vi.fn(async () => connection) };
  const create = () => new UploadDriveObjectAttemptUseCase(
    repository, credentials, drive, cipher, source, semaphore,
    resolver,
    {
      now: () => clock.value, owner: () => 'worker-1', leaseMs: options.leaseMs ?? 1_000,
      retryDelayMs: 1_000, providerGate,
    },
  );
  const fixture = {
    repository, artifactId: artifact.id, source, drive, cipher, semaphore, clock, resolver, journal,
    useCase: create(), newUseCase: create, providerSleeps, providerState,
    attemptId: () => drive.lastAttemptId ?? '',
    seedSession: async (confirmedOffset: number) => {
      const attempt = (await repository.listAttempts(artifact.id))[0];
      drive.lastAttemptId = attempt.id;
      const claim = await repository.claimAttempt(attempt.id, { owner: 'seed', nowMs: clock.value, leaseMs: 10 });
      const encrypted = await cipher.encrypt(Buffer.from(drive.session.uri), {
        installationId: 'installation-1', rowId: attempt.id, kind: 'upload-session', schemaVersion: 1,
      });
      await repository.saveSession(attempt.id, claim.lease, {
        ciphertext: encrypted.ciphertext, nonce: encrypted.iv, authTag: encrypted.authTag, keyVersion: 1, formatVersion: 1,
        createdAtMs: now - 100, expiresAtMs: now + 100_000, confirmedOffset,
      }, clock.value);
      clock.value += 11;
    },
  };
  return fixture;
}

class FakeCipher implements ArchiveSecretCipherPort {
  async encrypt(plaintext: Buffer): Promise<ArchiveSecretEnvelope> {
    return { version: 1, iv: 'nonce', ciphertext: plaintext.toString('base64'), authTag: 'tag' };
  }
  async decrypt(envelope: ArchiveSecretEnvelope): Promise<Buffer> {
    return Buffer.from(envelope.ciphertext, 'base64');
  }
}

class FakeSource implements ArchiveUploadSourcePort {
  readonly openStarts: number[] = [];
  readonly openEnds: number[] = [];
  maxRequestedBytes = 0;
  mutateAfterRead = false;
  statOverride: { size: number; mtimeNs: string } | null = null;
  statError: Error | null = null;
  readFailure: 'short' | 'long' | 'corrupt' | 'final-stat' | 'missing' | null = null;
  onYield?: (start: number) => void;
  private reads = 0;

  constructor(private readonly content: Buffer) {}

  async stat(): Promise<{ size: number; mtimeNs: string }> {
    if (this.statError !== null) throw this.statError;
    if (this.statOverride !== null) return this.statOverride;
    return {
      size: this.content.length,
      mtimeNs: (this.mutateAfterRead || this.readFailure === 'final-stat') && this.reads > 0 ? '124' : '123',
    };
  }

  open(_path: string, start: number, endExclusive: number): AsyncIterable<Uint8Array> {
    this.openStarts.push(start);
    this.openEnds.push(endExclusive);
    this.maxRequestedBytes = Math.max(this.maxRequestedBytes, endExclusive - start);
    this.reads += 1;
    const content = this.content;
    const onYield = this.onYield;
    const readFailure = this.readFailure;
    return (async function* () {
      if (readFailure === 'missing') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      const limit = readFailure === 'short' ? Math.max(start, endExclusive - 1) : endExclusive;
      for (let offset = start; offset < limit; offset += 64 * 1024) {
        onYield?.(start);
        const part = content.subarray(offset, Math.min(offset + 64 * 1024, limit));
        if (readFailure === 'corrupt' && offset === start && part.length > 0) {
          const corrupted = Buffer.from(part);
          corrupted[0] ^= 0xff;
          yield corrupted;
        } else {
          yield part;
        }
      }
      if (readFailure === 'long') yield new Uint8Array([1]);
    })();
  }
}

class FakeDrive implements DriveArchivePort {
  readonly generatedIds = ['reserved-1'];
  readonly session = { uri: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1', createdAtMs: now, expiresAtMs: now + 518_400_000 };
  readonly objects = new Map<string, VerifiedDriveObject>();
  readonly loadIds: string[] = [];
  readonly beginFileIds: string[] = [];
  readonly beginInputs: Parameters<DriveArchivePort['beginResumableUpload']>[0][] = [];
  generateCalls = 0;
  beginCalls = 0;
  uploadCalls = 0;
  queryCalls = 0;
  lastAttemptId: string | null = null;
  queryResult: Awaited<ReturnType<DriveArchivePort['querySession']>> = { kind: 'resume', confirmedOffset: 0 };
  failAfterRemoteCreate = false;
  conflictOnBegin = false;
  failChunkOnce = false;
  failChunkAfterConsumeOnce = false;
  queryError: Error | null = null;
  loadError: Error | null = null;
  remoteOverride: Partial<VerifiedDriveObject> = {};
  fallbackName = '120000-clip.mp4';
  fallbackParentId = 'day-folder-1';
  fallbackMimeType = 'video/mp4';
  artifactKind: 'motion_video' | 'database_backup' = 'motion_video';
  generateError: Error | null = null;
  acceptInvalidBodyLength = false;
  onGenerate?: () => void;
  onBegin?: () => Promise<void>;
  onChunk?: () => Promise<void>;

  constructor(private readonly content: Buffer, private readonly journal: string[]) {}

  async generateFileId(): Promise<string> {
    this.generateCalls += 1;
    this.onGenerate?.();
    if (this.generateError !== null) throw this.generateError;
    const id = this.generatedIds.shift();
    if (!id) throw new Error('no generated ID');
    return id;
  }

  async beginResumableUpload(input: Parameters<DriveArchivePort['beginResumableUpload']>[0]) {
    this.beginCalls += 1;
    this.beginFileIds.push(input.fileId);
    this.beginInputs.push(input);
    await this.onBegin?.();
    if (this.conflictOnBegin) throw Object.assign(new Error('reserved ID conflict'), { name: 'DriveObjectConflictError' });
    if (this.failAfterRemoteCreate) {
      this.objects.set(input.fileId, verified(
        input.fileId, this.content, this.remoteOverride, input.name, input.parentId, input.mimeType,
        this.artifactKind,
      ));
      throw new Error('timeout');
    }
    return this.session;
  }

  async querySession() {
    this.queryCalls += 1;
    this.journal.push('query-session');
    if (this.queryError !== null) throw this.queryError;
    return this.queryResult;
  }

  async uploadChunk(input: UploadChunk) {
    this.uploadCalls += 1;
    await this.onChunk?.();
    if (this.failChunkOnce) { this.failChunkOnce = false; throw new Error('network'); }
    let read = 0;
    for await (const part of input.body) read += part.byteLength;
    if (this.failChunkAfterConsumeOnce) {
      this.failChunkAfterConsumeOnce = false;
      throw new DriveTemporaryUnavailableError('network after body');
    }
    if (!this.acceptInvalidBodyLength) {
      expect(read).toBe(input.endInclusive - input.start + 1);
    }
    if (input.endInclusive + 1 === input.totalSize) {
      const begin = this.beginInputs.find((value) => value.fileId === input.fileId);
      this.objects.set(input.fileId, verified(
        input.fileId,
        this.content,
        this.remoteOverride,
        begin?.name ?? this.fallbackName,
        begin?.parentId ?? this.fallbackParentId,
        begin?.mimeType ?? this.fallbackMimeType,
        this.artifactKind,
      ));
      return { kind: 'complete' as const };
    }
    return { kind: 'resume' as const, confirmedOffset: input.endInclusive + 1 };
  }

  async loadObject(_connection: unknown, fileId: string): Promise<VerifiedDriveObject | null> {
    this.loadIds.push(fileId);
    if (this.loadError !== null) throw this.loadError;
    return this.objects.get(fileId) ?? null;
  }

  async listManagedObjects() { return { objects: [], nextPageToken: null, incompleteSearch: false }; }
  async deleteExact() { return undefined; }
}

function providerRateLimit(
  operationPhase: 'metadata' | 'session-query',
): DriveRateLimitedError {
  return new DriveRateLimitedError({
    retryAfterMs: 60_000,
    sessionUsable: false,
    operationPhase,
  });
}

function folderMutationFor(level: 'year' | 'month' | 'day'):
DriveFolderBranchBlockedError & { mutationLevel: 'year' | 'month' | 'day' } {
  const error = new DriveFolderBranchBlockedError() as DriveFolderBranchBlockedError & { mutationLevel: typeof level };
  error.message = `Drive motion ${level} folder branch changed during upload`;
  error.mutationLevel = level;
  return error;
}

async function expectExactRetryableAttempt(
  fixture: Awaited<ReturnType<typeof setup>>,
  containerId: string,
): Promise<void> {
  expect(await fixture.repository.loadArtifact(fixture.artifactId)).toMatchObject({
    state: 'pending', currentVerifiedAttemptId: null, localDeletedAtMs: null,
  });
  const [queued] = await fixture.repository.listAttempts(fixture.artifactId);
  const retained = await fixture.repository.loadAttempt(queued?.id ?? 'missing-attempt');
  expect(retained).toMatchObject({
    remoteObjectId: 'reserved-1', containerId, state: 'retryable',
    session: { ciphertext: expect.any(String), confirmedOffset: expect.any(Number) },
  });
  const session = retained?.session;

  await expect(fixture.repository.claimNextAttempt({
    generationId: 'generation-1', owner: 'reconciliation-worker',
    nowMs: fixture.clock.value + 1_000, leaseMs: 1_000,
    kind: 'motion_video', retryOnly: true,
  })).resolves.toMatchObject({
    attempt: {
      id: retained?.id, remoteObjectId: 'reserved-1', containerId, state: 'uploading',
      session: { ciphertext: session?.ciphertext, confirmedOffset: session?.confirmedOffset },
    },
  });
}

function verified(
  id: string,
  content: Buffer,
  override: Partial<VerifiedDriveObject>,
  name = '120000-clip.mp4',
  parentId = 'day-folder-1',
  mimeType = 'video/mp4',
  kind: 'motion_video' | 'database_backup' = 'motion_video',
): VerifiedDriveObject {
  return {
    id, name, parentId, mimeType, size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'), md5: null, createdTimeMs: now,
    headRevisionId: 'revision-1', version: '1', ownedByMe: true, canDelete: true, trashed: false,
    appProperties: { a1v: '1', a1i: 'installation-1', a1g: 'generation-1', a1k: kind, a1f: 'f'.repeat(64), a1s: digest, a1t: String(now - 1_000) },
    sharing: { ownerPermissionId: 'owner-1', shared: false, permissionIds: ['owner-1'] }, webViewLink: null,
    ...override,
  };
}
