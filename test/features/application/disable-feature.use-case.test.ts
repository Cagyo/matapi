import { describe, expect, it } from 'vitest';
import { DisableFeatureUseCase } from '../../../src/features/application/disable-feature.use-case';
import { FeatureAlreadyDisabledError } from '../../../src/features/domain/errors/feature-already-disabled.error';
import { UnknownFeatureError } from '../../../src/features/domain/errors/unknown-feature.error';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';

describe('DisableFeatureUseCase', () => {
  it('disables an enabled feature', async () => {
    const repo = new InMemoryFeatureRepository([
      { name: 'uart', enabled: true, installed: true, config: null },
    ]);
    const useCase = new DisableFeatureUseCase(repo);

    const feature = await useCase.execute('uart');

    expect(feature.enabled).toBe(false);
    expect((await repo.findByName('uart'))?.enabled).toBe(false);
  });

  it('throws UnknownFeatureError for a name outside the catalogue', async () => {
    const useCase = new DisableFeatureUseCase(new InMemoryFeatureRepository());
    await expect(useCase.execute('xyz')).rejects.toBeInstanceOf(
      UnknownFeatureError,
    );
  });

  it('throws FeatureAlreadyDisabledError when already disabled', async () => {
    const repo = new InMemoryFeatureRepository([
      { name: 'uart', enabled: false, installed: true, config: null },
    ]);
    const useCase = new DisableFeatureUseCase(repo);
    await expect(useCase.execute('uart')).rejects.toBeInstanceOf(
      FeatureAlreadyDisabledError,
    );
  });

  it('throws FeatureAlreadyDisabledError when no row exists', async () => {
    const useCase = new DisableFeatureUseCase(new InMemoryFeatureRepository());
    await expect(useCase.execute('zigbee')).rejects.toBeInstanceOf(
      FeatureAlreadyDisabledError,
    );
  });
});
