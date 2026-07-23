import { describe, expect, it } from 'vitest';
import { ListFeaturesUseCase } from '../../../src/features/application/list-features.use-case';
import { ListManageableFeaturesUseCase } from '../../../src/features/application/list-manageable-features.use-case';
import type { FeatureAvailabilityPort } from '../../../src/features/domain/ports/feature-availability.port';

describe('ListFeaturesUseCase', () => {
  it('delegates to the published manageable-feature projection', async () => {
    const availability: FeatureAvailabilityPort = {
      awaitInitialVerification: async () => undefined,
      inspect: async (name) => ({ name, enabled: false, installed: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install' }),
      requireReady: async () => undefined,
    };
    const useCase = new ListFeaturesUseCase(new ListManageableFeaturesUseCase(availability));

    const result = await useCase.execute();

    expect(result.map((feature) => feature.name)).toEqual(['digital', 'uart', 'zigbee', 'motion', 'rtsp']);
  });
});
