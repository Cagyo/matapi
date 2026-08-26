import { describe, expect, it } from 'vitest';
import { ListManageableFeaturesUseCase } from '../../../src/features/application/list-manageable-features.use-case';
import type { FeatureAvailabilityPort } from '../../../src/features/domain/ports/feature-availability.port';

describe('ListManageableFeaturesUseCase', () => {
  it('returns the five manageable features in canonical order', async () => {
    const availability = availabilityStub();
    const result = await new ListManageableFeaturesUseCase(availability).execute();

    expect(result.map((feature) => feature.name)).toEqual(['digital', 'uart', 'zigbee', 'motion', 'rtsp']);
  });
});

function availabilityStub(): FeatureAvailabilityPort {
  return {
    awaitInitialVerification: async () => undefined,
    inspect: async (name) => ({ name, installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install', secondaryAction: null }),
    requireReady: async () => undefined,
  };
}
