import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ListLiveSourcesUseCase } from '../../../src/camera/application/list-live-sources.use-case';
import type { LiveSourceRepositoryPort } from '../../../src/camera/domain/ports/live-source-repository.port';

describe('ListLiveSourcesUseCase', () => {
  it('returns only the repository redacted read model', async () => {
    const rows = [{ cameraId: 'c1', cameraName: 'front', summary: { scheme: 'rtsp', host: 'cam.local', transport: 'tcp', tlsMode: 'none', profile: 'eco', substreamHost: null, ready: true } }] as const;
    const repository = { listRedacted: vi.fn().mockResolvedValue(rows) } as unknown as LiveSourceRepositoryPort;
    await expect(new ListLiveSourcesUseCase(repository).execute()).resolves.toBe(rows);
  });

  /**
   * Removal is reached through a listing, so a readiness or start-gate check
   * here is what strands an admin who needs to clean up on a network the RTSP
   * policy cannot describe — the lock-out `retire`'s carve-out exists to
   * prevent. The dependency must be absent, not merely satisfied in tests.
   */
  it('takes no readiness or start-gate dependency', () => {
    const source = readFileSync(
      resolve('src/camera/application/list-live-sources.use-case.ts'),
      'utf8',
    );
    const body = source.slice(source.indexOf('export class'));

    expect(body).not.toMatch(/requireReady|assertCanStart|assertEpoch/u);
    expect(ListLiveSourcesUseCase.length).toBe(1);
  });
});
