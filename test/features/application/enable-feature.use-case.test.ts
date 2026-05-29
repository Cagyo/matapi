import { describe, expect, it } from 'vitest';
import { EnableFeatureUseCase } from '../../../src/features/application/enable-feature.use-case';
import { FeatureAlreadyEnabledError } from '../../../src/features/domain/errors/feature-already-enabled.error';
import { FeatureNotInstalledError } from '../../../src/features/domain/errors/feature-not-installed.error';
import { UnknownFeatureError } from '../../../src/features/domain/errors/unknown-feature.error';
import { InMemoryFeatureRepository } from '../../../src/features/infrastructure/in-memory-feature.repository';

describe('EnableFeatureUseCase', () => {
  it('enables an installed, disabled feature', async () => {
    const repo = new InMemoryFeatureRepository([
      { name: 'uart', enabled: false, installed: true, config: null },
    ]);
    const useCase = new EnableFeatureUseCase(repo);

    const feature = await useCase.execute('uart');

    expect(feature.enabled).toBe(true);
    expect((await repo.findByName('uart'))?.enabled).toBe(true);
  });

  it('throws UnknownFeatureError for a name outside the catalogue', async () => {
    const useCase = new EnableFeatureUseCase(new InMemoryFeatureRepository());
    await expect(useCase.execute('xyz')).rejects.toBeInstanceOf(
      UnknownFeatureError,
    );
  });

  it('throws FeatureNotInstalledError when deps are not installed', async () => {
    const repo = new InMemoryFeatureRepository([
      { name: 'motion', enabled: false, installed: false, config: null },
    ]);
    const useCase = new EnableFeatureUseCase(repo);
    await expect(useCase.execute('motion')).rejects.toBeInstanceOf(
      FeatureNotInstalledError,
    );
  });

  it('throws FeatureNotInstalledError when no row exists', async () => {
    const useCase = new EnableFeatureUseCase(new InMemoryFeatureRepository());
    await expect(useCase.execute('zigbee')).rejects.toBeInstanceOf(
      FeatureNotInstalledError,
    );
  });

  it('throws FeatureAlreadyEnabledError when already enabled', async () => {
    const repo = new InMemoryFeatureRepository([
      { name: 'uart', enabled: true, installed: true, config: null },
    ]);
    const useCase = new EnableFeatureUseCase(repo);
    await expect(useCase.execute('uart')).rejects.toBeInstanceOf(
      FeatureAlreadyEnabledError,
    );
  });
});
