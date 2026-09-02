import { type BigIntStats } from 'node:fs';
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
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalSourceFingerprintInput } from '../../../src/archive/domain/archive-artifact.entity';
import type { CompletedMotionVideoCandidate } from '../../../src/camera/domain/ports/completed-motion-video.port';
import { FsCompletedMotionVideoAdapter } from '../../../src/camera/infrastructure/fs-completed-motion-video.adapter';

const installationId = '00000000-0000-4000-8000-000000000001';
const HASH_BUFFER_BYTES = 64 * 1024;
const FAR_FUTURE = Number.MAX_SAFE_INTEGER;

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
    const secondCandidate = await traversal.inspect(second, signal);

    expect(await traversal.continueHash(firstCandidate!, hashBudget(HASH_BUFFER_BYTES), signal)).toEqual({
      kind: 'in-progress',
      hashedBytes: HASH_BUFFER_BYTES,
    });
    expect(tracking.openFileHandles()).toBe(1);

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

function nativeFilesystem(options: {
  onRead?: (input: { length: number; position: number | null }) => void;
} = {}) {
  const directories = new Set<object>();
  const files = new Set<object>();
  let maximumFiles = 0;
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
