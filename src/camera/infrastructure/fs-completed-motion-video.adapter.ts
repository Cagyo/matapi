import { constants } from 'node:fs';
import { open, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import type {
  CompletedMotionVideoDescriptor,
  CompletedMotionVideoPort,
} from '../domain/ports/completed-motion-video.port';

const STABILITY_MS = 60_000;
const HASH_BUFFER_BYTES = 64 * 1024;
const DEFAULT_SCAN_MULTIPLIER = 20;
const MOTION_VIDEO_PATH = /^(\d{4})\/(\d{2})\/(\d{2})\/(\d{6})-[A-Za-z0-9][A-Za-z0-9._-]*\.(avi|mkv|mp4)$/u;

export interface FsCompletedMotionVideoOptions {
  root?: string;
  now?: () => number;
  stabilityMs?: number;
  scanMultiplier?: number;
}

/**
 * No-follow filesystem boundary for Motion videos. A candidate is accepted
 * only after a fixed stability window and identical pre/post hash metadata.
 */
@Injectable()
export class FsCompletedMotionVideoAdapter implements CompletedMotionVideoPort {
  private readonly root: string;
  private readonly now: () => number;
  private readonly stabilityMs: number;
  private readonly scanMultiplier: number;

  constructor(options: FsCompletedMotionVideoOptions = {}) {
    this.root = resolve(options.root ?? process.env.MOTION_LOCAL_DIR ?? '/home/pi/motion/videos');
    this.now = options.now ?? Date.now;
    this.stabilityMs = options.stabilityMs ?? STABILITY_MS;
    this.scanMultiplier = options.scanMultiplier ?? DEFAULT_SCAN_MULTIPLIER;
  }

  async resolve(candidatePath: string): Promise<CompletedMotionVideoDescriptor | null> {
    const candidate = this.toContainedCandidate(candidatePath);
    if (!candidate) return null;

    const match = MOTION_VIDEO_PATH.exec(candidate.relativePath);
    if (!match) return null;

    const before = await this.lstatNoFollow(candidate.relativePath);
    if (!before || !before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    if (this.now() - Number(before.mtimeMs) < this.stabilityMs) return null;

    const size = Number(before.size);
    const beforeMtimeNs = before.mtimeNs.toString();
    const sha256 = await this.hashIfUnchanged(candidate.absolutePath, size, beforeMtimeNs);
    if (!sha256) return null;

    const after = await this.lstatNoFollow(candidate.relativePath);
    if (!after || !after.isFile() || after.size !== before.size || after.mtimeNs.toString() !== beforeMtimeNs) {
      return null;
    }

    const sourceTimeMs = motionSourceTimeMs(match);
    if (sourceTimeMs === null) return null;
    const sourceFingerprint = createHash('sha256')
      .update(`motion_video\0${size}\0${sha256}`, 'utf8')
      .digest('hex');

    return {
      kind: 'motion_video',
      sourceIdentity: `motion:${candidate.relativePath}`,
      trustedPath: candidate.absolutePath,
      relativePath: candidate.relativePath,
      size,
      mtimeNs: beforeMtimeNs,
      sourceTimeMs,
      sha256,
      sourceFingerprint,
    };
  }

  async scan(limit: number): Promise<readonly CompletedMotionVideoDescriptor[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    if (!(await this.isTrustedRoot())) return [];

    const descriptors: CompletedMotionVideoDescriptor[] = [];
    const pending = [''];
    let visited = 0;
    const maxVisited = limit * this.scanMultiplier;

    while (pending.length > 0 && descriptors.length < limit && visited < maxVisited) {
      const directoryRelativePath = pending.pop()!;
      const directory = directoryRelativePath ? join(this.root, directoryRelativePath) : this.root;
      try {
        const entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' });
        for (const entry of entries) {
          if (descriptors.length >= limit || visited >= maxVisited) break;
          visited += 1;
          if (entry.isSymbolicLink()) continue;
          const childRelativePath = directoryRelativePath
            ? `${directoryRelativePath}/${entry.name}`
            : entry.name;
          if (entry.isDirectory()) {
            pending.push(childRelativePath);
            continue;
          }
          if (!entry.isFile()) continue;
          const descriptor = await this.resolve(join(this.root, childRelativePath));
          if (descriptor) descriptors.push(descriptor);
        }
      } catch {
        continue;
      }
    }

    return descriptors;
  }

  private toContainedCandidate(candidatePath: string): { absolutePath: string; relativePath: string } | null {
    if (!candidatePath || candidatePath.includes('\0')) return null;
    const absolutePath = resolve(candidatePath);
    const relativePath = relative(this.root, absolutePath);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || relativePath.startsWith('/')) {
      return null;
    }
    return { absolutePath, relativePath: relativePath.split(sep).join('/') };
  }

  private async isTrustedRoot(): Promise<boolean> {
    try {
      const root = await lstat(this.root, { bigint: true });
      return root.isDirectory() && !root.isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** Checks every component beneath the exact root with lstat, never realpath. */
  private async lstatNoFollow(relativePath: string) {
    if (!(await this.isTrustedRoot())) return null;
    const parts = relativePath.split('/');
    let current = this.root;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]);
      try {
        const stat = await lstat(current, { bigint: true });
        if (stat.isSymbolicLink()) return null;
        if (index < parts.length - 1 && !stat.isDirectory()) return null;
        if (index === parts.length - 1) return stat;
      } catch {
        return null;
      }
    }
    return null;
  }

  private async hashIfUnchanged(
    filePath: string,
    expectedSize: number,
    expectedMtimeNs: string,
  ): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.size !== BigInt(expectedSize) || opened.mtimeNs.toString() !== expectedMtimeNs) {
        return null;
      }

      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
      let position = 0;
      while (position < expectedSize) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedSize - position), position);
        if (bytesRead === 0) return null;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return hash.digest('hex');
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }
}

function motionSourceTimeMs(match: RegExpExecArray): number | null {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hhmmss = match[4];
  const hour = Number(hhmmss.slice(0, 2));
  const minute = Number(hhmmss.slice(2, 4));
  const second = Number(hhmmss.slice(4, 6));
  const value = new Date(year, month - 1, day, hour, minute, second);
  return value.getFullYear() === year && value.getMonth() === month - 1 && value.getDate() === day
    && value.getHours() === hour && value.getMinutes() === minute && value.getSeconds() === second
    ? value.getTime()
    : null;
}
