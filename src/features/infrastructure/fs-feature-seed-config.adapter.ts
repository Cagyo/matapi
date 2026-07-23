import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isManageableFeature, type ManageableFeatureName } from '../domain/manageable-feature';
import type { FeatureSeedConfigPort } from '../domain/ports/feature-seed-config.port';

const MAX_BYTES = 4_096;

/** Bounded parser for the installer-owned, application-visible selection file. */
export class FsFeatureSeedConfigAdapter implements FeatureSeedConfigPort {
  constructor(private readonly path = resolve(process.cwd(), 'features.json')) {}

  async loadEnabled(): Promise<readonly ManageableFeatureName[] | null> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error: unknown) {
      if (isCode(error, 'ENOENT')) return null;
      return null;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_BYTES) return null;
      const bytes = Buffer.allocUnsafe(stat.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) return null;
      return parseEnabled(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, stat.size)));
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

function parseEnabled(raw: string): readonly ManageableFeatureName[] | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value) || !Array.isArray(value.enabled)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'enabled' || keys[1] !== 'liveStream' || keys[2] !== 'timestamp') return null;
  if (typeof value.liveStream !== 'boolean' || typeof value.timestamp !== 'string' || Number.isNaN(Date.parse(value.timestamp))) return null;
  const seen = new Set<ManageableFeatureName>();
  const enabled: ManageableFeatureName[] = [];
  for (const item of value.enabled) {
    if (!isManageableFeature(item) || seen.has(item)) return null;
    seen.add(item);
    enabled.push(item);
  }
  if (value.liveStream !== enabled.includes('rtsp')) return null;
  return enabled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
