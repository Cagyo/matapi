import { execFile } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  opendir,
  rename,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSourceFingerprintInput } from '../../../src/archive/domain/archive-artifact.entity';
import type { CompletedMotionVideoCandidate } from '../../../src/camera/domain/ports/completed-motion-video.port';
import { FsCompletedMotionVideoAdapter } from '../../../src/camera/infrastructure/fs-completed-motion-video.adapter';

const installationId = '00000000-0000-4000-8000-000000000001';
const HASH_BUFFER_BYTES = 64 * 1024;
const FAR_FUTURE = Number.MAX_SAFE_INTEGER;
const execFileAsync = promisify(execFile);

describe('FsCompletedMotionVideoAdapter', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) =>
      import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })),
    ));
  });

  async function fixture(name = '120000-12345.mp4', contents: string | Buffer = 'completed video'): Promise<{
    root: string;
    file: string;
    adapter: FsCompletedMotionVideoAdapter;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'motion-video-'));
    directories.push(root);
    const directory = join(root, '2026', '07', '29');
    await mkdir(directory, { recursive: true });
    const file = join(directory, name);
    await writeFile(file, contents);
    await makeStable(file);
    return {
      root,
      file,
      adapter: new FsCompletedMotionVideoAdapter({ root, now: () => Date.now(), installationId }),
    };
  }

  it.each(['empty', 'symlink', 'outside-root', 'partial', 'unexpected-extension', 'unstable'])(
    'rejects %s candidates',
    async (kind) => {
      const { root, file, adapter } = await fixture();
      if (kind === 'empty') await writeFile(file, '');
      if (kind === 'symlink') {
        const target = join(root, 'target.mp4');
        await writeFile(target, 'completed video');
        await unlink(file);
        await symlink(target, file);
      }
      if (kind === 'outside-root') {
        const outside = join(tmpdir(), `outside-${Date.now()}.mp4`);
        directories.push(outside);
        await writeFile(outside, 'completed video');
        expect(await adapter.resolve(outside)).toBeNull();
        return;
      }
      if (kind === 'partial') {
        const partial = join(root, '2026', '07', '29', '120000-12345.mp4.part');
        await writeFile(partial, 'completed video');
        expect(await adapter.resolve(partial)).toBeNull();
        return;
      }
      if (kind === 'unexpected-extension') {
        const other = join(root, '2026', '07', '29', '120000-12345.txt');
        await writeFile(other, 'completed video');
        expect(await adapter.resolve(other)).toBeNull();
        return;
      }
      if (kind === 'unstable') await utimes(file, new Date(), new Date());

      expect(await adapter.resolve(file)).toBeNull();
    },
  );

  it('returns a stable descriptor with a bounded SHA-256 fingerprint', async () => {
    const { file, adapter } = await fixture();

    const descriptor = await adapter.resolve(file);

    expect(descriptor).toMatchObject({
      kind: 'motion_video',
      size: 'completed video'.length,
      relativePath: '2026/07/29/120000-12345.mp4',
    });
    expect(descriptor?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(descriptor?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(descriptor?.sourceFingerprint).toBe(createHash('sha256').update(
      canonicalSourceFingerprintInput({
        installationId,
        kind: 'motion_video',
        relativePath: '2026/07/29/120000-12345.mp4',
        size: 'completed video'.length,
        mtimeNs: descriptor!.mtimeNs,
        sha256: descriptor!.sha256,
      }),
      'utf8',
    ).digest('hex'));
    expect(descriptor?.sourceTimeMs).toBe(Date.UTC(2026, 6, 29, 12, 0, 0));
  });

  it('fails closed when production installation identity is missing or malformed', async () => {
    const { root, file } = await fixture();

    expect(await new FsCompletedMotionVideoAdapter({ root, now: () => Date.now() }).resolve(file)).toBeNull();
    expect(await new FsCompletedMotionVideoAdapter({
      root,
      now: () => Date.now(),
      installationId: 'not-a-uuid',
    }).resolve(file)).toBeNull();
  });

  it.each([
    '1969/12/31/235959-before-epoch.mp4',
    '2026/02/29/120000-non-leap-day.mp4',
    '2026/00/01/120000-zero-month.mp4',
    '2026/13/01/120000-thirteenth-month.mp4',
    '2026/07/29/246000-invalid-time.mp4',
    '2026/7/29/120000-unpadded-month.mp4',
  ])('rejects malformed Motion timestamp path %s', async (relativePath) => {
    const root = await mkdtemp(join(tmpdir(), 'motion-video-invalid-time-'));
    directories.push(root);
    const file = join(root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'completed video');
    await makeStable(file);
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId });

    expect(await adapter.resolve(file)).toBeNull();
  });

  it('rejects a same-size, same-mtime replacement after immediate hashing', async () => {
    const { root, file } = await fixture();
    const original = await import('node:fs/promises').then(({ stat }) => stat(file));
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      now: () => Date.now(),
      installationId,
      afterHash: async () => {
        await rename(file, `${file}.old`);
        await writeFile(file, 'different video');
        await utimes(file, original.atime, original.mtime);
      },
    });

    expect(await adapter.resolve(file)).toBeNull();
  });

  it('rejects a Motion-root swap after immediate hashing', async () => {
    const { root, file } = await fixture();
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      now: () => Date.now(),
      installationId,
      afterHash: async () => {
        await rename(root, `${root}.old`);
        directories.push(`${root}.old`);
        await mkdir(join(root, '2026', '07', '29'), { recursive: true });
        await writeFile(join(root, '2026', '07', '29', '120000-12345.mp4'), 'completed video');
      },
    });

    expect(await adapter.resolve(file)).toBeNull();
  });

  it('streams 10,000 directory entries without readdir or materializing the directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motion-video-stream-'));
    directories.push(root);
    const filesystem = fakeLargeDirectoryFilesystem(root, 10_000);
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      now: () => Date.now(),
      installationId,
      filesystem,
    });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);

    const step = await traversal.nextCandidate({ entryLimit: 64 }, signal);

    expect(step).toEqual({ candidate: null, visitedEntries: 64, complete: false });
    expect(filesystem.opendir).toHaveBeenCalledTimes(1);
    expect(filesystem.readdir).not.toHaveBeenCalled();
    expect(filesystem.readCount()).toBe(64);
    await traversal.close();
    expect(filesystem.openHandles()).toBe(0);
  });

  it('honors the exact entry limit across retained directory state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motion-video-budget-'));
    directories.push(root);
    const filesystem = fakeLargeDirectoryFilesystem(root, 10);
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);

    expect(await traversal.nextCandidate({ entryLimit: 3 }, signal)).toEqual({
      candidate: null,
      visitedEntries: 3,
      complete: false,
    });
    expect(await traversal.nextCandidate({ entryLimit: 4 }, signal)).toEqual({
      candidate: null,
      visitedEntries: 4,
      complete: false,
    });
    expect(filesystem.readCount()).toBe(7);
    await traversal.close();
  });

  it('advances past known, invalid, and unhashed candidates across bounded calls', async () => {
    const { root } = await fixture('120000-known.mp4');
    const day = join(root, '2026', '07', '29');
    const second = join(day, '120001-unhashed.mkv');
    await writeFile(second, 'second video');
    await writeFile(join(day, 'notes.txt'), 'invalid');
    await makeStable(second);
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const observed: string[] = [];
    let complete = false;

    for (let batch = 0; batch < 32 && !complete; batch += 1) {
      const step = await traversal.nextCandidate({ entryLimit: 1 }, signal);
      if (step.candidate) observed.push(step.candidate.relativePath);
      complete = step.complete;
      expect(step.visitedEntries).toBeLessThanOrEqual(1);
    }

    expect(complete).toBe(true);
    expect(observed.sort()).toEqual([
      '2026/07/29/120000-known.mp4',
      '2026/07/29/120001-unhashed.mkv',
    ]);
    expect(traversal.pendingCandidate()).toBeNull();
    await traversal.close();
  });

  it('retains at most root/year/month/day handles and never descends invalid prefixes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motion-video-depth-'));
    directories.push(root);
    const day = join(root, '2026', '07', '29');
    await mkdir(day, { recursive: true });
    const valid = join(day, '120000-valid.mp4');
    await writeFile(valid, 'valid video');
    await makeStable(valid);
    await mkdir(join(day, 'extra', 'deep', 'deeper'), { recursive: true });
    await writeFile(join(day, 'extra', 'deep', 'deeper', '120001-hidden.mp4'), 'hidden video');
    await mkdir(join(root, 'not-year', 'one', 'two', 'three', 'four'), { recursive: true });
    await mkdir(join(root, '1969', '12', '31', 'extra'), { recursive: true });
    await mkdir(join(root, '2026', '13', '01'), { recursive: true });
    await mkdir(join(root, '2026', '02', '30'), { recursive: true });

    const openedDirectories: string[] = [];
    const filesystem = nativeFilesystem({ onOpenDirectory: (path) => openedDirectories.push(path) });
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const observed: string[] = [];
    let complete = false;
    for (let batch = 0; batch < 200 && !complete; batch += 1) {
      const step = await traversal.nextCandidate({ entryLimit: 2 }, signal);
      if (step.candidate) observed.push(step.candidate.relativePath);
      complete = step.complete;
    }

    expect(complete).toBe(true);
    expect(observed).toEqual(['2026/07/29/120000-valid.mp4']);
    expect(filesystem.maximumOpenDirectoryHandles()).toBeLessThanOrEqual(4);
    expect(openedDirectories.sort()).toEqual([
      root,
      join(root, '2026'),
      join(root, '2026', '02'),
      join(root, '2026', '07'),
      join(root, '2026', '07', '29'),
    ].sort());
    await traversal.close();
    expect(filesystem.openHandles()).toBe(0);
  });

  it('hashes a file across cooperative byte-budget batches', async () => {
    const bytes = Buffer.alloc((HASH_BUFFER_BYTES * 2) + 17, 0x5a);
    const { adapter } = await fixture('120000-large.mp4', bytes);
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const candidate = await firstCandidate(traversal, signal);

    const first = await traversal.continueHash(candidate, hashBudget(HASH_BUFFER_BYTES), signal);
    expect(first).toEqual({ kind: 'in-progress', hashedBytes: HASH_BUFFER_BYTES });
    expect(traversal.pendingCandidate()).toEqual(candidate);

    const second = await traversal.continueHash(candidate, hashBudget(HASH_BUFFER_BYTES), signal);
    expect(second).toEqual({ kind: 'in-progress', hashedBytes: HASH_BUFFER_BYTES });

    const final = await traversal.continueHash(candidate, hashBudget(HASH_BUFFER_BYTES), signal);
    expect(final).toMatchObject({
      kind: 'complete',
      hashedBytes: 17,
      descriptor: {
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    });
    expect(traversal.pendingCandidate()).toBeNull();
    await traversal.close();
  });

  it('never reads more than 64 KiB and never exceeds the exact per-call byte budget', async () => {
    const bytes = Buffer.alloc(HASH_BUFFER_BYTES * 2, 0x41);
    const { root, file } = await fixture('120000-budget.mp4', bytes);
    const reads: { length: number; position: number | null }[] = [];
    const filesystem = nativeFilesystem({
      onRead: ({ length, position }) => reads.push({ length, position }),
    });
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const candidate = await traversal.inspect(file, signal);
    expect(candidate).not.toBeNull();

    const result = await traversal.continueHash(candidate!, hashBudget(HASH_BUFFER_BYTES + 17), signal);

    expect(result).toEqual({ kind: 'in-progress', hashedBytes: HASH_BUFFER_BYTES + 17 });
    expect(reads).toEqual([
      { length: HASH_BUFFER_BYTES, position: 0 },
      { length: 17, position: HASH_BUFFER_BYTES },
    ]);
    await traversal.close();
  });

  it('stops at the monotonic deadline immediately after one bounded read', async () => {
    const bytes = Buffer.alloc(HASH_BUFFER_BYTES * 2, 0x42);
    const { root, file } = await fixture('120000-deadline.mp4', bytes);
    const reads: number[] = [];
    const clockValues = [0, 100];
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      installationId,
      filesystem: nativeFilesystem({ onRead: ({ length }) => reads.push(length) }),
      monotonicClock: { now: () => clockValues.shift() ?? 100 },
    });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const candidate = await traversal.inspect(file, signal);

    const result = await traversal.continueHash(candidate!, {
      hashByteLimit: HASH_BUFFER_BYTES * 2,
      deadlineMonotonicMs: 100,
    }, signal);

    expect(result).toEqual({ kind: 'in-progress', hashedBytes: HASH_BUFFER_BYTES });
    expect(reads).toEqual([HASH_BUFFER_BYTES]);
    await traversal.close();
  });

  it('does not read when the monotonic deadline is already reached', async () => {
    const bytes = Buffer.alloc(HASH_BUFFER_BYTES + 1, 0x43);
    const { root, file } = await fixture('120000-expired.mp4', bytes);
    const reads: number[] = [];
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      installationId,
      filesystem: nativeFilesystem({ onRead: ({ length }) => reads.push(length) }),
      monotonicClock: { now: () => 50 },
    });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const candidate = await traversal.inspect(file, signal);

    const result = await traversal.continueHash(candidate!, {
      hashByteLimit: HASH_BUFFER_BYTES,
      deadlineMonotonicMs: 50,
    }, signal);

    expect(result).toEqual({ kind: 'in-progress', hashedBytes: 0 });
    expect(reads).toEqual([]);
    await traversal.close();
  });

  it('closes the old partial hash before switching candidates', async () => {
    const firstBytes = Buffer.alloc(HASH_BUFFER_BYTES + 1, 0x31);
    const { root, file: first } = await fixture('120000-first.mp4', firstBytes);
    const second = join(root, '2026', '07', '29', '120001-second.mp4');
    await writeFile(second, Buffer.alloc(HASH_BUFFER_BYTES + 1, 0x32));
    await makeStable(second);
    const tracking = nativeFilesystem();
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem: tracking });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const firstCandidate = await traversal.inspect(first, signal);

    expect(await traversal.continueHash(firstCandidate!, hashBudget(HASH_BUFFER_BYTES), signal)).toEqual({
      kind: 'in-progress',
      hashedBytes: HASH_BUFFER_BYTES,
    });
    expect(tracking.openFileHandles()).toBe(1);

    const secondCandidate = await traversal.inspect(second, signal);
    expect(tracking.openFileHandles()).toBe(0);
    expect(await traversal.continueHash(secondCandidate!, hashBudget(HASH_BUFFER_BYTES), signal)).toEqual({
      kind: 'in-progress',
      hashedBytes: HASH_BUFFER_BYTES,
    });
    expect(traversal.pendingCandidate()).toEqual(secondCandidate);
    expect(tracking.maximumOpenFileHandles()).toBe(1);
    expect(tracking.openFileHandles()).toBe(1);
    await traversal.close();
    expect(tracking.openHandles()).toBe(0);
  });

  it('rejects a candidate offered by another traversal even when public metadata matches', async () => {
    const { file, adapter } = await fixture('120000-cross-traversal.mp4');
    const signal = new AbortController().signal;
    const first = await adapter.openTraversal(signal);
    const second = await adapter.openTraversal(signal);
    const foreignCandidate = await first.inspect(file, signal);
    const localCandidate = await second.inspect(file, signal);

    expect(foreignCandidate).toEqual(localCandidate);
    expect(await second.continueHash(foreignCandidate!, hashBudget(HASH_BUFFER_BYTES), signal)).toEqual({
      kind: 'rejected',
      hashedBytes: 0,
    });
    expect(await second.continueHash(localCandidate!, hashBudget(HASH_BUFFER_BYTES), signal)).toMatchObject({
      kind: 'complete',
      hashedBytes: 'completed video'.length,
    });
    await first.close();
    await second.close();
  });

  it('rejects a previously offered candidate displaced by a later inspection', async () => {
    const { root, file: first } = await fixture('120000-displaced.mp4');
    const second = join(root, '2026', '07', '29', '120001-current.mp4');
    await writeFile(second, 'second video');
    await makeStable(second);
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const displaced = await traversal.inspect(first, signal);
    const current = await traversal.inspect(second, signal);

    expect(await traversal.continueHash(displaced!, hashBudget(HASH_BUFFER_BYTES), signal)).toEqual({
      kind: 'rejected',
      hashedBytes: 0,
    });
    expect(await traversal.continueHash(current!, hashBudget(HASH_BUFFER_BYTES), signal)).toMatchObject({
      kind: 'complete',
      hashedBytes: 'second video'.length,
    });
    await traversal.close();
  });

  it('rejects a previously offered candidate displaced by the next traversal step', async () => {
    const { root } = await fixture('120000-first-offer.mp4');
    const second = join(root, '2026', '07', '29', '120001-second-offer.mp4');
    await writeFile(second, 'second video');
    await makeStable(second);
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const first = await firstCandidate(traversal, signal);
    const next = await traversal.nextCandidate({ entryLimit: 64 }, signal);

    expect(next.candidate).not.toBeNull();
    expect(next.candidate).not.toBe(first);
    expect(await traversal.continueHash(first, hashBudget(HASH_BUFFER_BYTES), signal)).toEqual({
      kind: 'rejected',
      hashedBytes: 0,
    });
    expect(await traversal.continueHash(next.candidate!, hashBudget(HASH_BUFFER_BYTES), signal)).toMatchObject({
      kind: 'complete',
    });
    await traversal.close();
  });

  it('reports every byte consumed when the final no-follow identity check rejects a replacement', async () => {
    const bytes = Buffer.alloc(HASH_BUFFER_BYTES + 19, 0x71);
    const { root, file } = await fixture('120000-replaced.mp4', bytes);
    const original = await import('node:fs/promises').then(({ stat }) => stat(file));
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      installationId,
      afterHash: async () => {
        await rename(file, `${file}.old`);
        await writeFile(file, Buffer.alloc(bytes.length, 0x72));
        await utimes(file, original.atime, original.mtime);
      },
    });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const candidate = await traversal.inspect(file, signal);

    const result = await traversal.continueHash(candidate!, hashBudget(bytes.length), signal);

    expect(result).toEqual({ kind: 'rejected', hashedBytes: bytes.length });
    expect(traversal.pendingCandidate()).toBeNull();
    await traversal.close();
  });

  it('rejects a same-metadata inode replacement between inspection and hashing', async () => {
    const bytes = Buffer.alloc(HASH_BUFFER_BYTES + 7, 0x73);
    const { root, file } = await fixture('120000-before-open.mp4', bytes);
    const original = await import('node:fs/promises').then(({ stat }) => stat(file));
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const candidate = await traversal.inspect(file, signal);
    await rename(file, `${file}.old`);
    await writeFile(file, Buffer.alloc(bytes.length, 0x74));
    await utimes(file, original.atime, original.mtime);

    expect(await traversal.continueHash(candidate!, hashBudget(bytes.length), signal)).toEqual({
      kind: 'rejected',
      hashedBytes: 0,
    });
    await traversal.close();
  });

  it('rejects a regular-file to unwritten-FIFO race without blocking or leaking a handle', async () => {
    const { root, file } = await fixture('120000-fifo-race.mp4');
    const native = nativeFilesystem();
    let openedFlags = 0;
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      installationId,
      filesystem: {
        ...native,
        open: async (path: string, flags: number) => {
          openedFlags = flags;
          if ((flags & constants.O_NONBLOCK) === 0) throw new Error('candidate open would block');
          await rename(path, `${path}.old`);
          await execFileAsync('mkfifo', [path]);
          return native.open(path, flags);
        },
      },
    });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const candidate = await traversal.inspect(file, signal);

    const result = await within(
      traversal.continueHash(candidate!, hashBudget(HASH_BUFFER_BYTES), signal),
      500,
    );

    expect(result).toEqual({ kind: 'rejected', hashedBytes: 0 });
    expect(openedFlags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(native.openHandles()).toBe(0);
    await traversal.close();
  });

  it('reports consumed bytes when the candidate becomes a symlink after hashing', async () => {
    const bytes = Buffer.alloc(HASH_BUFFER_BYTES + 23, 0x51);
    const { root, file } = await fixture('120000-symlinked.mp4', bytes);
    const target = join(root, 'replacement.mp4');
    await writeFile(target, bytes);
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      installationId,
      afterHash: async () => {
        await unlink(file);
        await symlink(target, file);
      },
    });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);
    const candidate = await traversal.inspect(file, signal);

    expect(await traversal.continueHash(candidate!, hashBudget(bytes.length), signal)).toEqual({
      kind: 'rejected',
      hashedBytes: bytes.length,
    });
    await traversal.close();
  });

  it('rejects an unstable candidate before opening a hash handle', async () => {
    const { root, file } = await fixture();
    await utimes(file, new Date(), new Date());
    const tracking = nativeFilesystem();
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem: tracking });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);

    expect(await traversal.inspect(file, signal)).toBeNull();
    expect(tracking.openFileHandles()).toBe(0);
    await traversal.close();
  });

  it('rehashes an incomplete candidate from byte zero after traversal restart', async () => {
    const bytes = Buffer.alloc(HASH_BUFFER_BYTES + 9, 0x61);
    const { root, file } = await fixture('120000-restart.mp4', bytes);
    const positions: number[] = [];
    const filesystem = nativeFilesystem({
      onRead: ({ position }) => positions.push(position ?? -1),
    });
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem });
    const signal = new AbortController().signal;
    const first = await adapter.openTraversal(signal);
    const firstCandidate = await first.inspect(file, signal);

    expect(await first.continueHash(firstCandidate!, hashBudget(HASH_BUFFER_BYTES), signal)).toEqual({
      kind: 'in-progress',
      hashedBytes: HASH_BUFFER_BYTES,
    });
    await first.close();

    const restarted = await adapter.openTraversal(signal);
    const restartedCandidate = await restarted.inspect(file, signal);
    expect(await restarted.continueHash(restartedCandidate!, hashBudget(HASH_BUFFER_BYTES), signal)).toEqual({
      kind: 'in-progress',
      hashedBytes: HASH_BUFFER_BYTES,
    });
    expect(positions).toEqual([0, 0]);
    await restarted.close();
  });

  it('closes retained directory and file handles when hashing observes cancellation', async () => {
    const bytes = Buffer.alloc(HASH_BUFFER_BYTES * 2, 0x22);
    const { root } = await fixture('120000-cancel.mp4', bytes);
    const controller = new AbortController();
    const filesystem = nativeFilesystem({ onRead: () => controller.abort(abortError()) });
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem });
    const traversal = await adapter.openTraversal(controller.signal);
    const candidate = await firstCandidate(traversal, controller.signal);

    await expect(traversal.continueHash(candidate, hashBudget(bytes.length), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(filesystem.openHandles()).toBe(0);
    await traversal.close();
    await traversal.close();
    expect(filesystem.openHandles()).toBe(0);
  });

  it('closes retained directory handles when traversal reads observe cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'motion-video-cancel-read-'));
    directories.push(root);
    const controller = new AbortController();
    const filesystem = fakeLargeDirectoryFilesystem(root, 10, () => controller.abort(abortError()));
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem });
    const traversal = await adapter.openTraversal(controller.signal);

    await expect(traversal.nextCandidate({ entryLimit: 1 }, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(filesystem.openHandles()).toBe(0);
  });

  it('rejects already-cancelled traversal operations without opening handles', async () => {
    const { root } = await fixture();
    const filesystem = nativeFilesystem();
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem });
    const controller = new AbortController();
    controller.abort(abortError());

    await expect(adapter.openTraversal(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(filesystem.openHandles()).toBe(0);
  });

  it('keeps immediate resolve cancellation-aware between 64 KiB reads', async () => {
    const bytes = Buffer.alloc(HASH_BUFFER_BYTES * 3, 0x7a);
    const { root, file } = await fixture('120000-immediate.mp4', bytes);
    const controller = new AbortController();
    const reads: number[] = [];
    const filesystem = nativeFilesystem({
      onRead: ({ length }) => {
        reads.push(length);
        controller.abort(abortError());
      },
    });
    const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem });

    await expect(adapter.resolve(file, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toEqual([HASH_BUFFER_BYTES]);
    expect(filesystem.openHandles()).toBe(0);
  });

  it.each([
    ['root inspection', 'inspect', 'EACCES', 'motion_fs_access_denied'],
    ['root directory open', 'read-directory', 'EIO', 'motion_fs_io_failure'],
    ['directory read', 'read-directory', 'EIO', 'motion_fs_io_failure'],
    ['candidate hashing', 'hash', 'EIO', 'motion_fs_io_failure'],
  ] as const)(
    'fails traversal on an operational %s error without exposing its path',
    async (scenario, operation, nodeCode, expectedCode) => {
      const { root, file } = await fixture();
      const native = nativeFilesystem();
      const secretPath = `${root}/private-video-path`;
      const filesystem = {
        ...native,
        lstat: async (path: string) => {
          if (scenario === 'root inspection' && path === root) throw filesystemError(nodeCode, secretPath);
          return native.lstat(path);
        },
        opendir: async (path: string) => {
          if (scenario === 'root directory open') throw filesystemError(nodeCode, secretPath);
          const directory = await native.opendir(path);
          if (scenario !== 'directory read') return directory;
          return {
            read: async () => { throw filesystemError(nodeCode, secretPath); },
            close: () => directory.close(),
          };
        },
        open: async (path: string, flags: number) => {
          if (scenario === 'candidate hashing' && path === file) {
            throw filesystemError(nodeCode, secretPath);
          }
          return native.open(path, flags);
        },
      };
      const adapter = new FsCompletedMotionVideoAdapter({ root, installationId, filesystem });
      const signal = new AbortController().signal;
      const traversal = await adapter.openTraversal(signal);

      const result = scenario === 'candidate hashing'
        ? traversal.inspect(file, signal).then((candidate) =>
          traversal.continueHash(candidate!, hashBudget(HASH_BUFFER_BYTES), signal))
        : traversal.nextCandidate({ entryLimit: 64 }, signal);

      await expect(result).rejects.toMatchObject({
        name: 'CompletedMotionVideoFilesystemError',
        code: expectedCode,
        operation,
      });
      await expect(result).rejects.not.toThrow(secretPath);
      expect(native.openHandles()).toBe(0);
    },
  );

  it('skips an expected directory-disappearance race', async () => {
    const { root } = await fixture();
    const native = nativeFilesystem();
    const adapter = new FsCompletedMotionVideoAdapter({
      root,
      installationId,
      filesystem: {
        ...native,
        opendir: async () => { throw filesystemError('ENOENT', `${root}/vanished`); },
      },
    });
    const signal = new AbortController().signal;
    const traversal = await adapter.openTraversal(signal);

    await expect(traversal.nextCandidate({ entryLimit: 64 }, signal)).resolves.toEqual({
      candidate: null,
      complete: true,
      visitedEntries: 0,
    });
    await traversal.close();
  });
});

function hashBudget(hashByteLimit: number) {
  return { hashByteLimit, deadlineMonotonicMs: FAR_FUTURE };
}

async function firstCandidate(
  traversal: Awaited<ReturnType<FsCompletedMotionVideoAdapter['openTraversal']>>,
  signal: AbortSignal,
): Promise<CompletedMotionVideoCandidate> {
  while (true) {
    const step = await traversal.nextCandidate({ entryLimit: 64 }, signal);
    if (step.candidate) return step.candidate;
    if (step.complete) throw new Error('fixture candidate not found');
  }
}

async function makeStable(path: string): Promise<void> {
  const stableAt = new Date(Date.now() - 61_000);
  await utimes(path, stableAt, stableAt);
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nativeFilesystem(options: {
  onRead?: (input: { length: number; position: number | null }) => void;
  onOpenDirectory?: (path: string) => void;
} = {}) {
  const directories = new Set<object>();
  const files = new Set<object>();
  let maximumFiles = 0;
  let maximumDirectories = 0;
  return {
    lstat: (path: string): Promise<BigIntStats> => lstat(path, { bigint: true }),
    opendir: async (path: string) => {
      const native = await opendir(path, { bufferSize: 1 });
      const tracked = {
        read: () => native.read(),
        close: async () => {
          if (!directories.delete(tracked)) return;
          await native.close();
        },
      };
      directories.add(tracked);
      maximumDirectories = Math.max(maximumDirectories, directories.size);
      options.onOpenDirectory?.(path);
      return tracked;
    },
    open: async (path: string, flags: number) => {
      const native = await open(path, flags);
      const tracked = {
        stat: (input: { bigint: true }) => native.stat(input),
        read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          const result = await native.read(buffer, offset, length, position);
          options.onRead?.({ length, position });
          return result;
        },
        close: async () => {
          if (!files.delete(tracked)) return;
          await native.close();
        },
      };
      files.add(tracked);
      maximumFiles = Math.max(maximumFiles, files.size);
      return tracked;
    },
    openHandles: () => directories.size + files.size,
    openFileHandles: () => files.size,
    maximumOpenFileHandles: () => maximumFiles,
    maximumOpenDirectoryHandles: () => maximumDirectories,
  };
}

function fakeLargeDirectoryFilesystem(root: string, entries: number, afterRead?: () => void) {
  let reads = 0;
  let handles = 0;
  let closed = false;
  const readdir = vi.fn();
  const opendirMock = vi.fn(async (path: string) => {
    expect(path).toBe(root);
    handles += 1;
    return {
      read: async () => {
        if (reads >= entries) return null;
        const index = reads;
        reads += 1;
        afterRead?.();
        return {
          name: `invalid-${index}.txt`,
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => true,
        };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        handles -= 1;
      },
    };
  });
  return {
    lstat: (path: string) => lstat(path, { bigint: true }),
    opendir: opendirMock,
    readdir,
    open: (path: string, flags: number) => open(path, flags),
    readCount: () => reads,
    openHandles: () => handles,
  };
}

function filesystemError(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}
