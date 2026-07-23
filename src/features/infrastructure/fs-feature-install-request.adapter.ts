import { constants } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertFeatureInstallRequest, parseFeatureInstallRequest, type FeatureInstallRequestV1 } from '../domain/manageable-feature';
import type { FeatureInstallRequestPort } from '../domain/ports/feature-install-request.port';

const DEFAULT_REQUEST_DIRECTORY = '/var/lib/home-worker/feature-install-requests';
const MAX_BYTES = 4_096;
const O_CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;

/** Publishes a closed-schema request without ever following a spool entry. */
export class FsFeatureInstallRequestAdapter implements FeatureInstallRequestPort {
  async publish(request: FeatureInstallRequestV1): Promise<'published' | 'already-published'> {
    // This assertion must run before a caller-controlled job ID reaches join().
    const canonical = assertFeatureInstallRequest(request);
    const body = `${JSON.stringify({ feature: canonical.feature, jobId: canonical.jobId, version: 1 })}\n`;
    const uid = process.getuid?.() ?? -1;
    const gid = process.getgid?.() ?? -1;
    await validateSpoolDirectory(DEFAULT_REQUEST_DIRECTORY, 0, gid, 0o730);
    const target = join(DEFAULT_REQUEST_DIRECTORY, `${canonical.jobId}.json`);
    const temporary = join(DEFAULT_REQUEST_DIRECTORY, `.${canonical.jobId}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_CLOEXEC, 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        // link(2) provides the no-replace atomicity that rename(2) lacks.
        await link(temporary, target);
        await unlink(temporary);
        await syncDirectory(DEFAULT_REQUEST_DIRECTORY);
        return 'published';
      } catch (error: unknown) {
        if (!isCode(error, 'EEXIST')) throw error;
        const current = await readSafeRequest(target, uid, gid);
        if (current === body) return 'already-published';
        throw new RangeError('Feature request conflicts with an existing spool entry');
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async cancelUnclaimed(request: FeatureInstallRequestV1): Promise<boolean> {
    const canonical = assertFeatureInstallRequest(request);
    const body = `${JSON.stringify({ feature: canonical.feature, jobId: canonical.jobId, version: 1 })}\n`;
    const uid = process.getuid?.() ?? -1;
    const gid = process.getgid?.() ?? -1;
    await validateSpoolDirectory(DEFAULT_REQUEST_DIRECTORY, 0, gid, 0o730);
    const target = join(DEFAULT_REQUEST_DIRECTORY, `${canonical.jobId}.json`);
    const cancellation = join(DEFAULT_REQUEST_DIRECTORY, `.${canonical.jobId}.${randomUUID()}.cancel`);
    try {
      // Claim the name first. The root helper consumes only *.json entries,
      // so a successful rename proves it cannot claim this request afterwards.
      await rename(target, cancellation);
      if (await readSafeRequest(cancellation, uid, gid) !== body) {
        await link(cancellation, target).then(() => unlink(cancellation)).catch(() => undefined);
        return false;
      }
      await unlink(cancellation);
      await syncDirectory(DEFAULT_REQUEST_DIRECTORY);
      return true;
    } catch (error: unknown) {
      if (isCode(error, 'ENOENT')) return false;
      await unlink(cancellation).catch(() => undefined);
      throw error;
    }
  }
}

async function readSafeRequest(path: string, uid: number, gid: number): Promise<string> {
  const handle = await openNoFollow(path);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > MAX_BYTES) {
      throw new RangeError('Feature request spool entry is unsafe');
    }
    const bytes = await readBounded(handle, stat.size);
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parseFeatureInstallRequest(raw);
    return raw;
  } finally { await handle.close(); }
}

export async function openNoFollow(path: string) {
  return open(path, constants.O_RDONLY | O_CLOEXEC | constants.O_NONBLOCK | constants.O_NOFOLLOW);
}

export async function readBounded(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<Uint8Array> {
  if (!Number.isInteger(size) || size < 1 || size > MAX_BYTES) throw new RangeError('Feature spool entry is oversized');
  const content = Buffer.allocUnsafe(size + 1);
  const { bytesRead } = await handle.read(content, 0, size + 1, 0);
  if (bytesRead !== size) throw new RangeError('Feature spool entry changed while being read');
  return content.subarray(0, size);
}

export async function syncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
  try { await descriptor.sync(); } finally { await descriptor.close(); }
}

export async function validateSpoolDirectory(directory: string, uid: number, gid: number, mode: number): Promise<void> {
  const descriptor = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC | constants.O_NOFOLLOW);
  try {
    const value = await descriptor.stat();
    if (!value.isDirectory() || value.uid !== uid || value.gid !== gid || (value.mode & 0o777) !== mode) {
      throw new RangeError('Feature spool directory is unsafe');
    }
  } finally { await descriptor.close(); }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
