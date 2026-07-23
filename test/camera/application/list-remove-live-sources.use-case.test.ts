import { describe, expect, it, vi } from 'vitest';
import { ListLiveSourcesUseCase } from '../../../src/camera/application/list-live-sources.use-case';
import { RemoveLiveSourceUseCase } from '../../../src/camera/application/remove-live-source.use-case';
import type { LiveSourceRepositoryPort } from '../../../src/camera/domain/ports/live-source-repository.port';
import type { LiveSourceSessionControlPort } from '../../../src/camera/domain/ports/live-source-session-control.port';
import { FeatureUnavailableError } from '../../../src/features/domain/errors/feature-unavailable.error';
import type { FeatureAvailabilityPort } from '../../../src/features/domain/ports/feature-availability.port';

describe('live source list/remove use cases', () => {
  it('returns only the repository redacted read model', async () => {
    const rows = [{ cameraId: 'c1', cameraName: 'front', summary: { scheme: 'rtsp', host: 'cam.local', transport: 'tcp', tlsMode: 'none', profile: 'eco', substreamHost: null, ready: true } }] as const;
    const repository = { listRedacted: vi.fn().mockResolvedValue(rows) } as unknown as LiveSourceRepositoryPort;
    await expect(new ListLiveSourcesUseCase(repository).execute()).resolves.toBe(rows);
  });

  it('stops before removing and preserves metadata when stop fails', async () => {
    const order: string[] = [];
    const sessions: LiveSourceSessionControlPort = {
      stopActiveSession: vi.fn(async () => { order.push('stop'); }),
    };
    const repository = {
      remove: vi.fn(async () => { order.push('remove'); }),
    } as unknown as LiveSourceRepositoryPort;
    const useCase = new RemoveLiveSourceUseCase(sessions, repository);
    await useCase.execute('c1');
    expect(order).toEqual(['stop', 'remove']);

    vi.mocked(sessions.stopActiveSession).mockRejectedValueOnce(new Error('busy'));
    await expect(useCase.execute('c1')).rejects.toThrow('busy');
    expect(repository.remove).toHaveBeenCalledOnce();
  });

  it('does not remove metadata when RTSP becomes unavailable during teardown', async () => {
    const sessions = { stopActiveSession: vi.fn().mockResolvedValue(undefined) } as unknown as LiveSourceSessionControlPort;
    const repository = { remove: vi.fn() } as unknown as LiveSourceRepositoryPort;
    const availability: FeatureAvailabilityPort = {
      awaitInitialVerification: vi.fn(), inspect: vi.fn(),
      requireReady: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new FeatureUnavailableError('rtsp', 'installed-off')),
    };

    await expect(new RemoveLiveSourceUseCase(sessions, repository, availability).execute('c1'))
      .rejects.toBeInstanceOf(FeatureUnavailableError);
    expect(repository.remove).not.toHaveBeenCalled();
  });
});
