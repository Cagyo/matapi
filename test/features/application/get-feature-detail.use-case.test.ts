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

  it('offers a reinstall at full install cost next to the cheaper primary action', async () => {
    const availability = availabilityStub('rtsp', 'reinstall');

    await expect(new GetFeatureDetailUseCase(availability).execute('rtsp')).resolves.toMatchObject({
      status: { action: 'disable' },
      impact: { restartScope: 'worker' },
      secondary: { action: 'reinstall', restartScope: 'supervisor' },
    });
  });

  it('offers no reinstall while the feature is not installed', async () => {
    await expect(new GetFeatureDetailUseCase(availabilityStub()).execute('rtsp')).resolves.toMatchObject({
      status: { action: 'install' },
      secondary: null,
    });
  });
});

function availabilityStub(
  enabledName?: string,
  secondaryAction: 'reinstall' | null = null,
): FeatureAvailabilityPort {
  return {
    awaitInitialVerification: async () => undefined,
    inspect: async (name) => name === enabledName
      ? { name, installed: true, enabled: true, ready: true, busy: false, attentionReason: null, display: 'enabled', action: 'disable', secondaryAction }
      : { name, installed: false, enabled: false, ready: false, busy: false, attentionReason: null, display: 'not-installed', action: 'install', secondaryAction: null },
    requireReady: async () => undefined,
  };
}
