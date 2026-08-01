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

const now = 1_000_000;
const bytes = Buffer.alloc(700_000, 7);
const digest = createHash('sha256').update(bytes).digest('hex');
const signal = new AbortController().signal;

describe('UploadDriveObjectAttemptUseCase', () => {
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

async function setup(options: { createAttempt?: boolean; leaseMs?: number } = {}) {
  const repository = new InMemoryArchiveArtifactRepository();
  const artifact = await repository.register({
    installationId: 'installation-1', kind: 'motion_video', sourceIdentity: 'motion:clip', trustedPath: '/motion/clip.mp4',
    relativePath: 'clip.mp4', size: bytes.length, mtimeNs: '123', sourceTimeMs: now - 1_000,
    sha256: digest, sourceFingerprint: 'f'.repeat(64),
  });
  const existingAttempt = options.createAttempt
    ? await repository.createAttempt(artifact.id, 'generation-1', 'reserved-1', 'motion-folder', now - 20)
    : null;
  const connection = DriveConnection.stage({ id: 'generation-1', installationId: 'installation-1', nowMs: 1 }).activate({
    permissionId: 'owner-1', email: null, displayName: null,
    folders: { rootId: 'root-folder', motionId: 'motion-folder', backupsId: 'backup-folder' }, nowMs: 2,
  });
  const source = new FakeSource(bytes);
  const drive = new FakeDrive(bytes);
  drive.lastAttemptId = existingAttempt?.id ?? null;
  const cipher = new FakeCipher();
  const semaphore = new ArchiveTransferSemaphoreService();
  const clock = { value: now, now() { return this.value; } };
  const credentials = { loadActive: vi.fn(async () => connection) };
  const create = () => new UploadDriveObjectAttemptUseCase(
    repository, credentials, drive, cipher, source, semaphore,
    { now: () => clock.value, owner: () => 'worker-1', leaseMs: options.leaseMs ?? 1_000, retryDelayMs: 1_000 },
  );
  const fixture = {
    repository, artifactId: artifact.id, source, drive, cipher, semaphore, clock,
    useCase: create(), newUseCase: create,
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
  onYield?: (start: number) => void;
  private reads = 0;

  constructor(private readonly content: Buffer) {}

  async stat(): Promise<{ size: number; mtimeNs: string }> {
    return { size: this.content.length, mtimeNs: this.mutateAfterRead && this.reads > 0 ? '124' : '123' };
  }

  open(_path: string, start: number, endExclusive: number): AsyncIterable<Uint8Array> {
    this.openStarts.push(start);
    this.openEnds.push(endExclusive);
    this.maxRequestedBytes = Math.max(this.maxRequestedBytes, endExclusive - start);
    this.reads += 1;
    const content = this.content;
    const onYield = this.onYield;
    return (async function* () {
      for (let offset = start; offset < endExclusive; offset += 64 * 1024) {
        onYield?.(start);
        yield content.subarray(offset, Math.min(offset + 64 * 1024, endExclusive));
      }
    })();
  }
}

class FakeDrive implements DriveArchivePort {
  readonly generatedIds = ['reserved-1'];
  readonly session = { uri: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1', createdAtMs: now, expiresAtMs: now + 518_400_000 };
  readonly objects = new Map<string, VerifiedDriveObject>();
  readonly loadIds: string[] = [];
  readonly beginFileIds: string[] = [];
  beginCalls = 0;
  uploadCalls = 0;
  lastAttemptId: string | null = null;
  queryResult: Awaited<ReturnType<DriveArchivePort['querySession']>> = { kind: 'resume', confirmedOffset: 0 };
  failAfterRemoteCreate = false;
  conflictOnBegin = false;
  failChunkOnce = false;
  remoteOverride: Partial<VerifiedDriveObject> = {};
  onGenerate?: () => void;
  onBegin?: () => Promise<void>;
  onChunk?: () => Promise<void>;

  constructor(private readonly content: Buffer) {}

  async generateFileId(): Promise<string> {
    this.onGenerate?.();
    const id = this.generatedIds.shift();
    if (!id) throw new Error('no generated ID');
    return id;
  }

  async beginResumableUpload(input: Parameters<DriveArchivePort['beginResumableUpload']>[0]) {
    this.beginCalls += 1;
    this.beginFileIds.push(input.fileId);
    await this.onBegin?.();
    if (this.conflictOnBegin) throw Object.assign(new Error('reserved ID conflict'), { name: 'DriveObjectConflictError' });
    if (this.failAfterRemoteCreate) {
      this.objects.set(input.fileId, verified(input.fileId, this.content, this.remoteOverride));
      throw new Error('timeout');
    }
    return this.session;
  }

  async querySession() { return this.queryResult; }

  async uploadChunk(input: UploadChunk) {
    this.uploadCalls += 1;
    await this.onChunk?.();
    if (this.failChunkOnce) { this.failChunkOnce = false; throw new Error('network'); }
    let read = 0;
    for await (const part of input.body) read += part.byteLength;
    expect(read).toBe(input.endInclusive - input.start + 1);
    if (input.endInclusive + 1 === input.totalSize) {
      this.objects.set(input.fileId, verified(input.fileId, this.content, this.remoteOverride));
      return { kind: 'complete' as const };
    }
    return { kind: 'resume' as const, confirmedOffset: input.endInclusive + 1 };
  }

  async loadObject(_connection: unknown, fileId: string): Promise<VerifiedDriveObject | null> {
    this.loadIds.push(fileId);
    return this.objects.get(fileId) ?? null;
  }

  async listManagedObjects() { return { objects: [], nextPageToken: null, incompleteSearch: false }; }
  async deleteExact() { return undefined; }
}

function verified(id: string, content: Buffer, override: Partial<VerifiedDriveObject>): VerifiedDriveObject {
  return {
    id, name: 'clip.mp4', parentId: 'motion-folder', mimeType: 'video/mp4', size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'), md5: null, createdTimeMs: now,
    headRevisionId: 'revision-1', version: '1', ownedByMe: true, canDelete: true, trashed: false,
    appProperties: { a1v: '1', a1i: 'installation-1', a1g: 'generation-1', a1k: 'motion_video', a1f: 'f'.repeat(64), a1s: digest, a1t: String(now - 1_000) },
    sharing: { ownerPermissionId: 'owner-1', shared: false, permissionIds: ['owner-1'] }, webViewLink: null,
    ...override,
  };
}
