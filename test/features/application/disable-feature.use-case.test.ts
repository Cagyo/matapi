import { describe, expect, it } from 'vitest';
import { DisableFeatureUseCase } from '../../../src/features/application/disable-feature.use-case';
import { FeatureAlreadyDisabledError } from '../../../src/features/domain/errors/feature-already-disabled.error';
import { UnknownFeatureError } from '../../../src/features/domain/errors/unknown-feature.error';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';

const noLifecycle = { beforeDisable: async () => undefined };

describe('DisableFeatureUseCase', () => {
  it('disables an enabled feature', async () => {
    const repo = new InMemoryFeatureRepository([
      { name: 'uart', enabled: true, installed: true, config: null },
    ]);
    const useCase = new DisableFeatureUseCase(repo, noLifecycle);

    const feature = await useCase.execute('uart');

    expect(feature.enabled).toBe(false);
    expect((await repo.findByName('uart'))?.enabled).toBe(false);
  });

  it('throws UnknownFeatureError for a name outside the catalogue', async () => {
    const useCase = new DisableFeatureUseCase(new InMemoryFeatureRepository(), noLifecycle);
    await expect(useCase.execute('xyz')).rejects.toBeInstanceOf(
      UnknownFeatureError,
    );
  });

  it('throws FeatureAlreadyDisabledError when already disabled', async () => {
    const repo = new InMemoryFeatureRepository([
      { name: 'uart', enabled: false, installed: true, config: null },
    ]);
    const useCase = new DisableFeatureUseCase(repo, noLifecycle);
    await expect(useCase.execute('uart')).rejects.toBeInstanceOf(
      FeatureAlreadyDisabledError,
    );
  });

  it('throws FeatureAlreadyDisabledError when no row exists', async () => {
    const useCase = new DisableFeatureUseCase(new InMemoryFeatureRepository(), noLifecycle);
    await expect(useCase.execute('zigbee')).rejects.toBeInstanceOf(
      FeatureAlreadyDisabledError,
    );
  });

  it('runs lifecycle cleanup before persisting the disabled flag', async () => {
    const order: string[] = [];
    const repo = new InMemoryFeatureRepository([
      { name: 'rtsp', enabled: true, installed: true, config: null },
    ]);
    const original = repo.setEnabled.bind(repo);
    repo.setEnabled = async (...args) => {
      order.push('persist');
      return original(...args);
    };
    const useCase = new DisableFeatureUseCase(repo, {
      beforeDisable: async () => { order.push('cleanup'); },
    });

    await useCase.execute('rtsp');

    expect(order).toEqual(['cleanup', 'persist']);
  });

  it('does not persist disabled when lifecycle cleanup fails', async () => {
    const repo = new InMemoryFeatureRepository([
      { name: 'rtsp', enabled: true, installed: true, config: null },
    ]);
    const useCase = new DisableFeatureUseCase(repo, {
      beforeDisable: async () => { throw new Error('cleanup failed'); },
    });

    await expect(useCase.execute('rtsp')).rejects.toThrow('cleanup failed');
    expect((await repo.findByName('rtsp'))?.enabled).toBe(true);
  });
});
