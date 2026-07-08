import { describe, expect, it } from 'vitest';
import { MetaGdriveSyncHealth } from '../../../src/camera/infrastructure/meta-gdrive-sync-health';
import { SystemMetaRepositoryPort } from '../../../src/system/domain/ports/system-meta-repository.port';

function memMeta() {
  const store = new Map<string, string>();
  const meta: SystemMetaRepositoryPort = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
    delete: async (key) => void store.delete(key),
  };
  return { meta, store };
}

describe('MetaGdriveSyncHealth', () => {
  it('starts healthy with no persisted state', async () => {
    const { meta } = memMeta();
    const health = new MetaGdriveSyncHealth(meta);
    await health.onApplicationBootstrap();

    expect(health.snapshot()).toEqual({
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessAt: null,
    });
  });

  it('survives a restart: failures and last error rehydrate', async () => {
    const { meta } = memMeta();
    const before = new MetaGdriveSyncHealth(meta);
    await before.onApplicationBootstrap();
    await before.recordFailure('quota exceeded');
    await before.recordFailure('quota exceeded');

    const after = new MetaGdriveSyncHealth(meta);
    await after.onApplicationBootstrap();

    expect(after.snapshot().consecutiveFailures).toBe(2);
    expect(after.snapshot().lastError).toBe('quota exceeded');
  });

  it('survives a restart: last success timestamp rehydrates and resets failures', async () => {
    const { meta } = memMeta();
    const at = new Date('2026-07-08T03:00:00Z');
    const before = new MetaGdriveSyncHealth(meta);
    await before.onApplicationBootstrap();
    await before.recordFailure('blip');
    await before.recordSuccess(at);

    const after = new MetaGdriveSyncHealth(meta);
    await after.onApplicationBootstrap();

    expect(after.snapshot()).toEqual({
      consecutiveFailures: 0,
      lastError: null,
      lastSuccessAt: at,
    });
  });
});
