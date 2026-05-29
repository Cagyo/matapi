import { describe, expect, it } from 'vitest';
import { ListFeaturesUseCase } from '../../../src/features/application/list-features.use-case';
import { FEATURE_CATALOG } from '../../../src/features/domain/feature-catalog';
import { InMemoryFeatureQuery } from '../../../src/features/infrastructure/in-memory-feature.query';

describe('ListFeaturesUseCase', () => {
  it('reports every catalogue feature, merging persisted state', async () => {
    const query = new InMemoryFeatureQuery([
      { name: 'digital', enabled: true, installed: true, config: null },
      { name: 'uart', enabled: false, installed: true, config: null },
    ]);
    const useCase = new ListFeaturesUseCase(query);

    const result = await useCase.execute();

    expect(result).toHaveLength(FEATURE_CATALOG.length);
    expect(result.find((f) => f.name === 'digital')).toMatchObject({
      enabled: true,
      installed: true,
    });
    expect(result.find((f) => f.name === 'uart')).toMatchObject({
      enabled: false,
      installed: true,
    });
  });

  it('defaults features with no row to disabled and not installed', async () => {
    const useCase = new ListFeaturesUseCase(new InMemoryFeatureQuery());

    const result = await useCase.execute();

    expect(result.every((f) => !f.enabled && !f.installed)).toBe(true);
    expect(result.find((f) => f.name === 'zigbee')).toMatchObject({
      name: 'zigbee',
      description: 'Zigbee2MQTT gateway',
      enabled: false,
      installed: false,
    });
  });
});
