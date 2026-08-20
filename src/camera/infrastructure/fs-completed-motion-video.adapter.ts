import { constants, type BigIntStats } from 'node:fs';
import { open, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { canonicalSourceFingerprintInput } from '../../archive/domain/archive-artifact.entity';
import type {
  CompletedMotionVideoDescriptor,
  CompletedMotionVideoPort,
  CompletedMotionVideoScanBatch,
  CompletedMotionVideoScanCursor,
} from '../domain/ports/completed-motion-video.port';

const STABILITY_MS = 60_000;
const HASH_BUFFER_BYTES = 64 * 1024;
const MOTION_VIDEO_PATH = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{6})-[A-Za-z0-9][A-Za-z0-9._-]*\.(avi|mkv|mp4)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface FsCompletedMotionVideoOptions {
  root?: string;
  installationId?: string;
  now?: () => number;
  stabilityMs?: number;
  /** Test seam invoked after the stable descriptor bytes are hashed. */
  afterHash?: () => Promise<void> | void;
}

interface PathIdentity {
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

interface InspectedCandidate {
  file: BigIntStats;
  identities: readonly PathIdentity[];
}

interface ScanFrame {
  relativeDirectory: string;
  nextEntry: number;
}

/**
 * No-follow filesystem boundary for Motion videos. It preserves the identity
 * of every root-to-file component while hashing, so pathname swaps cannot be
 * registered as the bytes just read.
 */
@Injectable()
export class FsCompletedMotionVideoAdapter implements CompletedMotionVideoPort {
  private readonly root: string;
  private readonly installationId: string | null;
  private readonly now: () => number;
  private readonly stabilityMs: number;
  private readonly afterHash?: () => Promise<void> | void;

  constructor(options: FsCompletedMotionVideoOptions = {}) {
    this.root = resolve(options.root ?? process.env.MOTION_LOCAL_DIR ?? '/home/pi/motion/videos');
    this.installationId = isInstallationId(options.installationId) ? options.installationId : null;
    this.now = options.now ?? Date.now;
    this.stabilityMs = options.stabilityMs ?? STABILITY_MS;
    this.afterHash = options.afterHash;
  }

  async resolve(candidatePath: string): Promise<CompletedMotionVideoDescriptor | null> {
    if (!this.installationId) return null;
    const candidate = this.toContainedCandidate(candidatePath);
    if (!candidate) return null;
    const match = MOTION_VIDEO_PATH.exec(candidate.relativePath);
    if (!match) return null;

    const before = await this.inspectNoFollow(candidate.relativePath);
    if (!before || !before.file.isFile() || before.file.size <= 0n || before.file.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    if (this.now() - Number(before.file.mtimeMs) < this.stabilityMs) return null;

    const size = Number(before.file.size);
    const mtimeNs = before.file.mtimeNs.toString();
    const sha256 = await this.hashIfSameFile(candidate.absolutePath, before.file);
    if (!sha256) return null;
    await this.afterHash?.();

    const after = await this.inspectNoFollow(candidate.relativePath);
    if (!after || !sameCandidate(before, after)) return null;

    const sourceTimeMs = motionSourceTimeMs(match);
    if (sourceTimeMs === null) return null;
    const sourceFingerprint = createHash('sha256').update(canonicalSourceFingerprintInput({
      installationId: this.installationId,
      kind: 'motion_video',
      relativePath: candidate.relativePath,
      size,
      mtimeNs,
      sha256,
    }), 'utf8').digest('hex');

    return {
      kind: 'motion_video',
      sourceIdentity: `motion:${candidate.relativePath}`,
      trustedPath: candidate.absolutePath,
      relativePath: candidate.relativePath,
      size,
      mtimeNs,
      sourceTimeMs,
      sha256,
      sourceFingerprint,
    };
  }

  async scanBatch(input: {
    cursor: CompletedMotionVideoScanCursor | null;
    entryLimit: number;
  }): Promise<CompletedMotionVideoScanBatch> {
    if (!this.installationId || !Number.isSafeInteger(input.entryLimit) || input.entryLimit <= 0) {
      return { descriptors: [], cursor: null, complete: true, visitedEntries: 0 };
    }
    if (!(await this.inspectDirectory(''))) {
      return { descriptors: [], cursor: null, complete: true, visitedEntries: 0 };
    }
    const frames: ScanFrame[] = input.cursor === null
      ? [{ relativeDirectory: '', nextEntry: 0 }]
      : input.cursor.frames.map((frame) => ({
        relativeDirectory: frame.relativeDirectory,
        nextEntry: frame.nextEntry,
      }));
    const descriptors: CompletedMotionVideoDescriptor[] = [];
    let visited = 0;
    while (frames.length > 0 && visited < input.entryLimit) {
      const frame = frames.shift()!;
      if (!validFrame(frame)) continue;
      if (!(await this.inspectDirectory(frame.relativeDirectory))) continue;
      const directory = frame.relativeDirectory
        ? join(this.root, frame.relativeDirectory)
        : this.root;
      try {
        const entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' });
        const ordered = entries.sort((left, right) => String(left.name).localeCompare(String(right.name)));
        let index = frame.nextEntry;
        for (; index < ordered.length && visited < input.entryLimit; index += 1) {
          const entry = ordered[index];
          visited += 1;
          if (entry.isSymbolicLink()) continue;
          const child = frame.relativeDirectory
            ? `${frame.relativeDirectory}/${entry.name}`
            : String(entry.name);
          if (entry.isDirectory()) {
            frames.push({ relativeDirectory: child, nextEntry: 0 });
            continue;
          }
          if (!entry.isFile()) continue;
          const descriptor = await this.resolve(join(this.root, child));
          if (descriptor) descriptors.push(descriptor);
        }
        if (index < ordered.length) {
          frames.unshift({ relativeDirectory: frame.relativeDirectory, nextEntry: index });
        }
      } catch {
        continue;
      }
    }
    const complete = frames.length === 0;
    return {
      descriptors,
      cursor: complete ? null : { frames: frames.map((frame) => ({ ...frame })) },
      complete,
      visitedEntries: visited,
    };
  }

  private toContainedCandidate(candidatePath: string): { absolutePath: string; relativePath: string } | null {
    if (!candidatePath || candidatePath.includes('\0')) return null;
    const absolutePath = resolve(candidatePath);
    const relativePath = relative(this.root, absolutePath);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.startsWith('/')) return null;
    return { absolutePath, relativePath: relativePath.split(sep).join('/') };
  }

  private async inspectNoFollow(relativePath: string): Promise<InspectedCandidate | null> {
    const parts = relativePath.split('/');
    let current = this.root;
    const identities: PathIdentity[] = [];
    for (let index = -1; index < parts.length; index += 1) {
      if (index >= 0) current = join(current, parts[index]);
      let stat: BigIntStats;
      try {
        stat = await lstat(current, { bigint: true });
      } catch {
        return null;
      }
      if (stat.isSymbolicLink()) return null;
      if (index < parts.length - 1 && !stat.isDirectory()) return null;
      identities.push(identity(stat));
      if (index === parts.length - 1) return { file: stat, identities };
    }
    return null;
  }

  private async inspectDirectory(relativePath: string): Promise<boolean> {
    if (!relativePath) {
      try {
        const root = await lstat(this.root, { bigint: true });
        return root.isDirectory() && !root.isSymbolicLink();
      } catch {
        return false;
      }
    }
    const inspected = await this.inspectNoFollow(relativePath);
    return inspected?.file.isDirectory() ?? false;
  }

  private async hashIfSameFile(filePath: string, expected: BigIntStats): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFile(expected, opened)) return null;
      const expectedSize = Number(expected.size);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
      let position = 0;
      while (position < expectedSize) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - position), position);
        if (bytesRead === 0) return null;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const final = await handle.stat({ bigint: true });
      return sameFile(expected, final) ? hash.digest('hex') : null;
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }
}

function identity(stat: BigIntStats): PathIdentity {
  return { dev: stat.dev, ino: stat.ino, ctimeNs: stat.ctimeNs };
}

function sameCandidate(left: InspectedCandidate, right: InspectedCandidate): boolean {
  return sameFile(left.file, right.file)
    && left.identities.length === right.identities.length
    && left.identities.every((current, index) => {
      const other = right.identities[index];
      return current.dev === other.dev && current.ino === other.ino;
    });
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function isInstallationId(value: string | undefined): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function motionSourceTimeMs(match: RegExpExecArray): number | null {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hhmmss = match[4];
  const hour = Number(hhmmss.slice(0, 2));
  const minute = Number(hhmmss.slice(2, 4));
  const second = Number(hhmmss.slice(4, 6));
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const value = new Date(timestamp);
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day
    && value.getUTCHours() === hour && value.getUTCMinutes() === minute && value.getUTCSeconds() === second
    ? timestamp
    : null;
}

function validFrame(frame: ScanFrame): boolean {
  return Number.isSafeInteger(frame.nextEntry)
    && frame.nextEntry >= 0
    && !frame.relativeDirectory.includes('\0')
    && frame.relativeDirectory !== '..'
    && !frame.relativeDirectory.startsWith('../')
    && !frame.relativeDirectory.startsWith('/');
}
