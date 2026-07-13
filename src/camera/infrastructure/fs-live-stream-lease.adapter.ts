import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLiveStreamProcessId,
  type LiveStreamLease,
  type LiveStreamMessageReference,
} from '../domain/live-stream.entity';
import type { LiveStreamLeasePort } from '../domain/ports/live-stream-lease.port';

const LEASE_FILE = 'lease.json';

@Injectable()
export class FsLiveStreamLeaseAdapter implements LiveStreamLeasePort {
  constructor(
    private readonly runtimeDirectory =
      process.env.LIVE_STREAM_RUNTIME_DIR ?? '/run/home-worker/live-stream',
  ) {}

  async read(): Promise<LiveStreamLease | null> {
    try {
      const raw: unknown = JSON.parse(
        await readFile(join(this.runtimeDirectory, LEASE_FILE), 'utf8'),
      );
      const lease = parseLease(raw);
      if (!lease) throw new InvalidLeaseError();
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Live stream lease could not be read');
    }
  }

  async write(lease: LiveStreamLease): Promise<void> {
    await mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.runtimeDirectory, 0o700);
    const target = join(this.runtimeDirectory, LEASE_FILE);
    const temporary = join(this.runtimeDirectory, `.${LEASE_FILE}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(lease), 'utf8');
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      await syncDirectory(this.runtimeDirectory);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    await rm(join(this.runtimeDirectory, LEASE_FILE), { force: true });
    await syncDirectory(this.runtimeDirectory);
  }
}

class InvalidLeaseError extends Error {}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') {
      throw error;
    }
  }
}

function parseLease(value: unknown): LiveStreamLease | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.sessionNonce) || !nonEmptyString(value.processIdentity)) return null;
  if (!nonEmptyString(value.cameraId) || !positiveSafeInteger(value.pid)) return null;
  if (!nonNegativeSafeInteger(value.diagnosticExpiresAtUnixMs)) return null;
  if (!Array.isArray(value.messageReferences)) return null;
  if (value.sourceKind !== undefined && value.sourceKind !== 'motion-mjpeg' && value.sourceKind !== 'rtsp') return null;
  const messageReferences = value.messageReferences.map(parseMessageReference);
  if (messageReferences.some((reference) => reference === null)) return null;
  return {
    sessionNonce: value.sessionNonce,
    pid: createLiveStreamProcessId(value.pid),
    processIdentity: value.processIdentity,
    cameraId: value.cameraId,
    ...(value.sourceKind === undefined ? {} : { sourceKind: value.sourceKind }),
    diagnosticExpiresAtUnixMs: value.diagnosticExpiresAtUnixMs,
    messageReferences: messageReferences as LiveStreamMessageReference[],
  };
}

function parseMessageReference(value: unknown): LiveStreamMessageReference | null {
  if (!isRecord(value)) return null;
  if (!positiveSafeInteger(value.telegramId)) return null;
  if (!Number.isSafeInteger(value.chatId) || !positiveSafeInteger(value.messageId)) return null;
  return {
    telegramId: value.telegramId,
    chatId: value.chatId as number,
    messageId: value.messageId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
