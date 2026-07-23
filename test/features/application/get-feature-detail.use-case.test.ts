import { describe, expect, it } from 'vitest';
import { GetFeatureDetailUseCase } from '../../../src/features/application/get-feature-detail.use-case';
import type { FeatureAvailabilityPort } from '../../../src/features/domain/ports/feature-availability.port';

describe('GetFeatureDetailUseCase', () => {
  it('uses the conservative install restart scope for the current action', async () => {
    const availability = availabilityStub();
    const useCase = new GetFeatureDetailUseCase(availability);

    await expect(useCase.execute('uart')).resolves.toMatchObject({
      status: { action: 'install' },
      impact: { dependencies: 'uart', controls: 'uart-sensors', monitoring: 'sensor-work', restartScope: 'host' },
    });
  });

  it('discloses worker restart for a toggle', async () => {
    const availability = availabilityStub('motion');

    await expect(new GetFeatureDetailUseCase(availability).execute('motion')).resolves.toMatchObject({
      impact: { restartScope: 'worker' },
    });
  });
});

function availabilityStub(enabledName?: string): FeatureAvailabilityPort {
  return {
    awaitInitialVerification: async () => undefined,
    inspect: async (name) => name === enabledName
      ? { name, installed: true, enabled: true, ready: true, busy: false, attentionReason: null, display: 'enabled', action: 'disable' }
      : { name, installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install' },
    requireReady: async () => undefined,
  };
}
