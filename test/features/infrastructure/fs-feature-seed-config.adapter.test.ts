import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsFeatureSeedConfigAdapter } from '../../../src/features/infrastructure/fs-feature-seed-config.adapter';

const roots: string[] = [];
const file = (content?: string) => {
  const root = mkdtempSync(join(tmpdir(), 'feature-seed-config-'));
  roots.push(root);
  const target = join(root, 'features.json');
  if (content !== undefined) writeFileSync(target, content);
  return target;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('FsFeatureSeedConfigAdapter', () => {
  it('returns null for a missing or malformed bounded config', async () => {
    await expect(new FsFeatureSeedConfigAdapter(file()).loadEnabled()).resolves.toBeNull();
    await expect(new FsFeatureSeedConfigAdapter(file('{bad')).loadEnabled()).resolves.toBeNull();
    await expect(new FsFeatureSeedConfigAdapter(file(JSON.stringify({ enabled: ['4g'] }))).loadEnabled()).resolves.toBeNull();
  });

  it('returns only the verified manageable list', async () => {
    await expect(new FsFeatureSeedConfigAdapter(file(JSON.stringify({ enabled: ['digital', 'rtsp'], liveStream: true, timestamp: new Date().toISOString() }))).loadEnabled())
      .resolves.toEqual(['digital', 'rtsp']);
  });
});
