import { describe, expect, it, vi } from 'vitest';
import { ListLiveSourcesUseCase } from '../../../src/camera/application/list-live-sources.use-case';
import type { LiveSourceRepositoryPort } from '../../../src/camera/domain/ports/live-source-repository.port';

describe('ListLiveSourcesUseCase', () => {
  it('returns only the repository redacted read model', async () => {
    const rows = [{ cameraId: 'c1', cameraName: 'front', summary: { scheme: 'rtsp', host: 'cam.local', transport: 'tcp', tlsMode: 'none', profile: 'eco', substreamHost: null, ready: true } }] as const;
    const repository = { listRedacted: vi.fn().mockResolvedValue(rows) } as unknown as LiveSourceRepositoryPort;
    await expect(new ListLiveSourcesUseCase(repository).execute()).resolves.toBe(rows);
  });
});
