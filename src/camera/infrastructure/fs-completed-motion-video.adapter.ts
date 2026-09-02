import { createHash, type Hash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat as nodeLstat,
  open as nodeOpen,
  opendir as nodeOpenDir,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Injectable } from '@nestjs/common';
import { canonicalSourceFingerprintInput } from '../../archive/domain/archive-artifact.entity';
import {
  CompletedMotionVideoFilesystemError,
  type CompletedMotionVideoFilesystemErrorCode,
  type CompletedMotionVideoFilesystemOperation,
} from '../domain/errors/completed-motion-video-filesystem.error';
import type { MonotonicClockPort } from '../domain/ports/monotonic-clock.port';
import type {
  CompletedMotionHashResult,
  CompletedMotionVideoCandidate,
  CompletedMotionVideoDescriptor,
  CompletedMotionVideoPort,
  CompletedMotionVideoTraversal,
} from '../domain/ports/completed-motion-video.port';

const STABILITY_MS = 60_000;
const HASH_BUFFER_BYTES = 64 * 1024;
const DIRECTORY_BUFFER_ENTRIES = 32;
const MOTION_VIDEO_PATH = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{6})-[A-Za-z0-9][A-Za-z0-9._-]*\.(avi|mkv|mp4)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface FsCompletedMotionVideoOptions {
  root?: string;
  installationId?: string;
  now?: () => number;
  monotonicClock?: MonotonicClockPort;
  stabilityMs?: number;
  /** Test seam invoked after the stable descriptor bytes are hashed. */
  afterHash?: () => Promise<void> | void;
  filesystem?: CompletedMotionVideoFilesystem;
}

interface DirectoryEntry {
  name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface DirectoryHandle {
  read(): Promise<DirectoryEntry | null>;
  close(): Promise<void>;
}

interface ReadFileHandle {
  stat(input: { bigint: true }): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

interface CompletedMotionVideoFilesystem {
  lstat(path: string): Promise<BigIntStats>;
  opendir(path: string): Promise<DirectoryHandle>;
  open(path: string, flags: number): Promise<ReadFileHandle>;
}

interface PathIdentity {
  dev: bigint;
  ino: bigint;
}

interface InspectedCandidate {
  file: BigIntStats;
  identities: readonly PathIdentity[];
}

interface OpenDirectory {
  relativeDirectory: string;
  handle: DirectoryHandle;
}

interface InProgressHash {
  candidate: CompletedMotionVideoCandidate;
  handle: ReadFileHandle;
  expected: InspectedCandidate;
  hash: Hash;
  position: number;
}

interface InspectedMotionCandidate {
  candidate: CompletedMotionVideoCandidate;
  inspected: InspectedCandidate;
}

interface TraversalDependencies {
  root: string;
  installationId: string | null;
  now: () => number;
  monotonicClock: MonotonicClockPort;
  stabilityMs: number;
  afterHash?: () => Promise<void> | void;
  filesystem: CompletedMotionVideoFilesystem;
}

/**
 * No-follow filesystem boundary for Motion videos. The public traversal is
 * opaque while all live directory, file, and hash state remains in this adapter.
 */
@Injectable()
export class FsCompletedMotionVideoAdapter implements CompletedMotionVideoPort {
  private readonly dependencies: TraversalDependencies;

  constructor(options: FsCompletedMotionVideoOptions = {}) {
    this.dependencies = {
      root: resolve(options.root ?? process.env.MOTION_LOCAL_DIR ?? '/home/pi/motion/videos'),
      installationId: isInstallationId(options.installationId) ? options.installationId : null,
      now: options.now ?? Date.now,
      monotonicClock: options.monotonicClock ?? SYSTEM_MONOTONIC_CLOCK,
      stabilityMs: options.stabilityMs ?? STABILITY_MS,
      afterHash: options.afterHash,
      filesystem: options.filesystem ?? NODE_FILESYSTEM,
    };
  }

  async resolve(
    candidatePath: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CompletedMotionVideoDescriptor | null> {
    throwIfAborted(signal);
    const traversal = new FsCompletedMotionVideoTraversal(this.dependencies);
    try {
      const candidate = await traversal.inspect(candidatePath, signal);
      if (!candidate) return null;
      while (true) {
        const result = await traversal.continueHash(candidate, {
          hashByteLimit: Number.MAX_SAFE_INTEGER,
          deadlineMonotonicMs: Number.POSITIVE_INFINITY,
        }, signal);
        if (result.kind === 'complete') return result.descriptor;
        if (result.kind === 'rejected') return null;
      }
    } finally {
      await traversal.close();
    }
  }

  async openTraversal(signal: AbortSignal): Promise<CompletedMotionVideoTraversal> {
    throwIfAborted(signal);
    return new FsCompletedMotionVideoTraversal(this.dependencies);
  }
}

class FsCompletedMotionVideoTraversal implements CompletedMotionVideoTraversal {
  private readonly directories: OpenDirectory[] = [];
  private readonly hashBuffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  private started = false;
  private exhausted = false;
  private closed = false;
  private offered: InspectedMotionCandidate | null = null;
  private inProgress: InProgressHash | null = null;

  constructor(private readonly dependencies: TraversalDependencies) {}

  pendingCandidate(): CompletedMotionVideoCandidate | null {
    return this.inProgress?.candidate ?? null;
  }

  async inspect(candidatePath: string, signal: AbortSignal): Promise<CompletedMotionVideoCandidate | null> {
    return this.run(signal, async () => {
      await this.closeInProgressHash();
      this.offered = null;
      const result = await this.inspectCandidate(candidatePath, signal);
      this.offered = result;
      return result?.candidate ?? null;
    });
  }

  async nextCandidate(
    input: { entryLimit: number },
    signal: AbortSignal,
  ): Promise<{ candidate: CompletedMotionVideoCandidate | null; visitedEntries: number; complete: boolean }> {
    return this.run(signal, async () => {
      if (this.closed || this.exhausted || !this.dependencies.installationId) {
        return { candidate: null, visitedEntries: 0, complete: true };
      }
      if (!Number.isSafeInteger(input.entryLimit) || input.entryLimit <= 0) {
        return { candidate: null, visitedEntries: 0, complete: false };
      }
      if (this.inProgress) {
        return { candidate: this.inProgress.candidate, visitedEntries: 0, complete: false };
      }
      this.offered = null;
      if (!this.started) {
        this.started = true;
        const root = await this.openDirectory('', signal);
        if (!root) {
          this.exhausted = true;
          return { candidate: null, visitedEntries: 0, complete: true };
        }
        this.directories.push(root);
      }

      let visitedEntries = 0;
      while (this.directories.length > 0 && visitedEntries < input.entryLimit) {
        throwIfAborted(signal);
        const current = this.directories[this.directories.length - 1];
        let entry: DirectoryEntry | null;
        try {
          entry = await current.handle.read();
        } catch (error) {
          if (isExpectedFilesystemRace(error)) {
            await this.popDirectory();
            continue;
          }
          throw filesystemFailure('read-directory', error);
        }
        throwIfAborted(signal);
        if (!entry) {
          await this.popDirectory();
          continue;
        }

        visitedEntries += 1;
        if (!safeDirectoryEntryName(entry.name) || entry.isSymbolicLink()) continue;
        const relativePath = current.relativeDirectory
          ? `${current.relativeDirectory}/${entry.name}`
          : entry.name;
        if (entry.isDirectory()) {
          if (!validMotionDirectoryPrefix(relativePath)) continue;
          const child = await this.openDirectory(relativePath, signal);
          if (child) this.directories.push(child);
          continue;
        }
        if (!entry.isFile()) continue;

        const inspected = await this.inspectCandidate(join(this.dependencies.root, relativePath), signal);
        if (!inspected) continue;
        this.offered = inspected;
        return { candidate: inspected.candidate, visitedEntries, complete: false };
      }

      if (this.directories.length === 0) this.exhausted = true;
      return { candidate: null, visitedEntries, complete: this.exhausted };
    });
  }

  async continueHash(
    candidate: CompletedMotionVideoCandidate,
    input: { hashByteLimit: number; deadlineMonotonicMs: number },
    signal: AbortSignal,
  ): Promise<CompletedMotionHashResult> {
    return this.run(signal, async () => {
      if (this.closed || !this.dependencies.installationId) return rejected(0);

      if (this.inProgress) {
        if (this.inProgress.candidate !== candidate) return rejected(0);
      } else {
        if (this.offered?.candidate !== candidate) return rejected(0);
        const started = await this.startHash(candidate, signal);
        if (!started) return this.rejectHash(0);
      }

      const byteLimit = Number.isSafeInteger(input.hashByteLimit) && input.hashByteLimit > 0
        ? input.hashByteLimit
        : 0;
      if (byteLimit === 0 || this.dependencies.monotonicClock.now() >= input.deadlineMonotonicMs) {
        return { kind: 'in-progress', hashedBytes: 0 };
      }

      let hashedBytes = 0;
      while (hashedBytes < byteLimit) {
        throwIfAborted(signal);
        const active = this.inProgress;
        if (!active) return rejected(hashedBytes);
        const remainingFileBytes = active.candidate.size - active.position;
        const readLength = Math.min(HASH_BUFFER_BYTES, byteLimit - hashedBytes, remainingFileBytes);
        if (readLength <= 0) return this.completeHash(hashedBytes, signal);

        let bytesRead: number;
        try {
          ({ bytesRead } = await active.handle.read(this.hashBuffer, 0, readLength, active.position));
        } catch (error) {
          if (isExpectedFilesystemRace(error)) return this.rejectHash(hashedBytes);
          throw filesystemFailure('hash', error);
        }
        throwIfAborted(signal);
        if (bytesRead <= 0) return this.rejectHash(hashedBytes);

        active.hash.update(this.hashBuffer.subarray(0, bytesRead));
        active.position += bytesRead;
        hashedBytes += bytesRead;
        const deadlineReached = this.dependencies.monotonicClock.now() >= input.deadlineMonotonicMs;
        if (active.position === active.candidate.size) return this.completeHash(hashedBytes, signal);
        if (deadlineReached) return { kind: 'in-progress', hashedBytes };
      }
      return { kind: 'in-progress', hashedBytes };
    });
  }

  async close(): Promise<void> {
    if (this.closed && !this.inProgress && this.directories.length === 0) return;
    this.closed = true;
    this.exhausted = true;
    this.offered = null;
    await this.closeInProgressHash();
    while (this.directories.length > 0) await this.popDirectory();
  }

  private async inspectCandidate(
    candidatePath: string,
    signal: AbortSignal,
  ): Promise<InspectedMotionCandidate | null> {
    if (this.closed || !this.dependencies.installationId) return null;
    const candidate = toContainedCandidate(this.dependencies.root, candidatePath);
    if (!candidate) return null;
    const match = MOTION_VIDEO_PATH.exec(candidate.relativePath);
    if (!match) return null;
    const sourceTimeMs = motionSourceTimeMs(match);
    if (sourceTimeMs === null) return null;

    const inspected = await this.inspectNoFollow(candidate.relativePath, signal);
    if (!inspected || !validStableFile(inspected.file, this.dependencies.now(), this.dependencies.stabilityMs)) {
      return null;
    }
    return {
      candidate: Object.freeze({
        sourceIdentity: `motion:${candidate.relativePath}`,
        trustedPath: candidate.absolutePath,
        relativePath: candidate.relativePath,
        size: Number(inspected.file.size),
        mtimeNs: inspected.file.mtimeNs.toString(),
        sourceTimeMs,
      }),
      inspected,
    };
  }

  private async startHash(candidate: CompletedMotionVideoCandidate, signal: AbortSignal): Promise<boolean> {
    const offered = this.offered;
    if (offered?.candidate !== candidate) return false;
    this.offered = null;
    const expected = offered.inspected;
    const current = await this.inspectNoFollow(candidate.relativePath, signal);
    if (!current
      || !validStableFile(current.file, this.dependencies.now(), this.dependencies.stabilityMs)
      || !sameInspectedCandidate(expected, current)) {
      return false;
    }

    let handle: ReadFileHandle | null = null;
    try {
      handle = await this.dependencies.filesystem.open(
        candidate.trustedPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      throwIfAborted(signal);
      const opened = await handle.stat({ bigint: true });
      throwIfAborted(signal);
      if (!opened.isFile() || !sameFile(expected.file, opened)) {
        await closeFileHandle(handle);
        return false;
      }
      this.inProgress = {
        candidate,
        handle,
        expected,
        hash: createHash('sha256'),
        position: 0,
      };
      return true;
    } catch (error) {
      if (handle) await closeFileHandle(handle);
      if (isExpectedFilesystemRace(error)) return false;
      if (isAbort(error, signal)) throw error;
      throw filesystemFailure('hash', error);
    }
  }

  private async completeHash(
    hashedBytes: number,
    signal: AbortSignal,
  ): Promise<CompletedMotionHashResult> {
    const active = this.inProgress;
    const installationId = this.dependencies.installationId;
    if (!active || !installationId) return this.rejectHash(hashedBytes);

    let finalOpened: BigIntStats;
    try {
      finalOpened = await active.handle.stat({ bigint: true });
    } catch (error) {
      if (isExpectedFilesystemRace(error)) return this.rejectHash(hashedBytes);
      throw filesystemFailure('hash', error);
    }
    throwIfAborted(signal);
    if (!finalOpened.isFile() || !sameFile(active.expected.file, finalOpened)) {
      return this.rejectHash(hashedBytes);
    }

    const sha256 = active.hash.digest('hex');
    await this.dependencies.afterHash?.();
    throwIfAborted(signal);
    const finalPath = await this.inspectNoFollow(active.candidate.relativePath, signal);
    if (!finalPath || !sameInspectedCandidate(active.expected, finalPath)) {
      return this.rejectHash(hashedBytes);
    }

    const descriptor = descriptorFor(active.candidate, installationId, sha256);
    await this.closeInProgressHash();
    return { kind: 'complete', descriptor, hashedBytes };
  }

  private async rejectHash(hashedBytes: number): Promise<CompletedMotionHashResult> {
    await this.closeInProgressHash();
    this.offered = null;
    return rejected(hashedBytes);
  }

  private async openDirectory(relativeDirectory: string, signal: AbortSignal): Promise<OpenDirectory | null> {
    const before = await this.inspectNoFollow(relativeDirectory, signal);
    if (!before?.file.isDirectory()) return null;
    const absolutePath = relativeDirectory
      ? join(this.dependencies.root, relativeDirectory)
      : this.dependencies.root;
    let handle: DirectoryHandle | null = null;
    try {
      handle = await this.dependencies.filesystem.opendir(absolutePath);
      throwIfAborted(signal);
      const after = await this.inspectNoFollow(relativeDirectory, signal);
      if (!after || !after.file.isDirectory() || !sameInspectedCandidate(before, after)) {
        await closeDirectoryHandle(handle);
        return null;
      }
      return { relativeDirectory, handle };
    } catch (error) {
      if (handle) await closeDirectoryHandle(handle);
      if (isExpectedFilesystemRace(error)) return null;
      if (isAbort(error, signal)) throw error;
      throw filesystemFailure('read-directory', error);
    }
  }

  private async inspectNoFollow(
    relativePath: string,
    signal: AbortSignal,
  ): Promise<InspectedCandidate | null> {
    const parts = relativePath === '' ? [] : relativePath.split('/');
    let current = this.dependencies.root;
    const identities: PathIdentity[] = [];
    for (let index = 0; index <= parts.length; index += 1) {
      if (index > 0) current = join(current, parts[index - 1]);
      let stat: BigIntStats;
      try {
        stat = await this.dependencies.filesystem.lstat(current);
      } catch (error) {
        if (isExpectedFilesystemRace(error)) return null;
        throw filesystemFailure('inspect', error);
      }
      throwIfAborted(signal);
      if (stat.isSymbolicLink()) return null;
      const final = index === parts.length;
      if (!final && !stat.isDirectory()) return null;
      identities.push(identity(stat));
      if (final) return { file: stat, identities };
    }
    return null;
  }

  private async popDirectory(): Promise<void> {
    const directory = this.directories.pop();
    if (directory) await closeDirectoryHandle(directory.handle);
  }

  private async closeInProgressHash(): Promise<void> {
    const active = this.inProgress;
    this.inProgress = null;
    if (active) await closeFileHandle(active.handle);
  }

  private async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    try {
      throwIfAborted(signal);
      const result = await operation();
      throwIfAborted(signal);
      return result;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
}

const SYSTEM_MONOTONIC_CLOCK: MonotonicClockPort = {
  now: () => performance.now(),
};

const NODE_FILESYSTEM: CompletedMotionVideoFilesystem = {
  lstat: filesystemLstat,
  opendir: filesystemOpenDir,
  open: filesystemOpen,
};

function filesystemLstat(path: string): Promise<BigIntStats> {
  return nodeLstat(path, { bigint: true });
}

function filesystemOpenDir(path: string): Promise<DirectoryHandle> {
  return nodeOpenDir(path, { bufferSize: DIRECTORY_BUFFER_ENTRIES });
}

function filesystemOpen(path: string, flags: number): Promise<ReadFileHandle> {
  return nodeOpen(path, flags);
}

function descriptorFor(
  candidate: CompletedMotionVideoCandidate,
  installationId: string,
  sha256: string,
): CompletedMotionVideoDescriptor {
  const sourceFingerprint = createHash('sha256').update(canonicalSourceFingerprintInput({
    installationId,
    kind: 'motion_video',
    relativePath: candidate.relativePath,
    size: candidate.size,
    mtimeNs: candidate.mtimeNs,
    sha256,
  }), 'utf8').digest('hex');
  return {
    kind: 'motion_video',
    ...candidate,
    sha256,
    sourceFingerprint,
  };
}

function rejected(hashedBytes: number): CompletedMotionHashResult {
  return { kind: 'rejected', hashedBytes };
}

function toContainedCandidate(
  root: string,
  candidatePath: string,
): { absolutePath: string; relativePath: string } | null {
  if (!candidatePath || candidatePath.includes('\0')) return null;
  const absolutePath = resolve(candidatePath);
  const relativePath = relative(root, absolutePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.startsWith('/')) {
    return null;
  }
  return { absolutePath, relativePath: relativePath.split(sep).join('/') };
}

function validStableFile(stat: BigIntStats, nowMs: number, stabilityMs: number): boolean {
  return stat.isFile()
    && stat.size > 0n
    && stat.size <= BigInt(Number.MAX_SAFE_INTEGER)
    && nowMs - Number(stat.mtimeMs) >= stabilityMs;
}

function sameInspectedCandidate(left: InspectedCandidate, right: InspectedCandidate): boolean {
  return sameFile(left.file, right.file)
    && left.identities.length === right.identities.length
    && left.identities.every((current, index) => {
      const other = right.identities[index];
      return current.dev === other.dev && current.ino === other.ino;
    });
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function identity(stat: BigIntStats): PathIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function safeDirectoryEntryName(name: string): boolean {
  return name !== ''
    && name !== '.'
    && name !== '..'
    && !name.includes('\0')
    && !name.includes('/')
    && !name.includes(sep);
}

function validMotionDirectoryPrefix(relativeDirectory: string): boolean {
  const parts = relativeDirectory.split('/');
  if (parts.length < 1 || parts.length > 3 || !/^\d{4}$/u.test(parts[0])) return false;
  const year = Number(parts[0]);
  if (year < 1970) return false;
  if (parts.length === 1) return true;
  if (!/^\d{2}$/u.test(parts[1])) return false;
  const month = Number(parts[1]);
  if (month < 1 || month > 12) return false;
  if (parts.length === 2) return true;
  if (!/^\d{2}$/u.test(parts[2])) return false;
  const day = Number(parts[2]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

async function closeDirectoryHandle(handle: DirectoryHandle): Promise<void> {
  await handle.close().catch(() => undefined);
}

async function closeFileHandle(handle: ReadFileHandle): Promise<void> {
  await handle.close().catch(() => undefined);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
}

function isExpectedFilesystemRace(error: unknown): boolean {
  const code = nodeErrorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'ESTALE';
}

function filesystemFailure(
  operation: CompletedMotionVideoFilesystemOperation,
  error: unknown,
): CompletedMotionVideoFilesystemError {
  const code = nodeErrorCode(error);
  const safeCode: CompletedMotionVideoFilesystemErrorCode = code === 'EACCES' || code === 'EPERM'
    ? 'motion_fs_access_denied'
    : code === 'EIO'
      ? 'motion_fs_io_failure'
      : 'motion_fs_unavailable';
  return new CompletedMotionVideoFilesystemError(safeCode, operation);
}

function nodeErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : null;
}

function isInstallationId(value: string | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function motionSourceTimeMs(match: RegExpExecArray): number | null {
  const year = Number(match[1]);
  if (year < 1970) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hhmmss = match[4];
  const hour = Number(hhmmss.slice(0, 2));
  const minute = Number(hhmmss.slice(2, 4));
  const second = Number(hhmmss.slice(4, 6));
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const value = new Date(timestamp);
  return value.getUTCFullYear() === year
    && value.getUTCMonth() === month - 1
    && value.getUTCDate() === day
    && value.getUTCHours() === hour
    && value.getUTCMinutes() === minute
    && value.getUTCSeconds() === second
    ? timestamp
    : null;
}
