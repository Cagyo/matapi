import { describe, expect, it, vi } from 'vitest';
import { FeatureSensorRuntimeLifecycleService } from '../../../src/sensors/application/feature-sensor-runtime-lifecycle.service';

describe('FeatureSensorRuntimeLifecycleService', () => {
  it('stops the exact feature before disable and resumes it after enable', async () => {
    const registry = {
      stopFeature: vi.fn().mockResolvedValue(undefined),
      resumeFeature: vi.fn().mockResolvedValue(undefined),
    };
    const lifecycle = new FeatureSensorRuntimeLifecycleService(registry as never);

    await lifecycle.forFeature('digital').beforeDisable();
    await lifecycle.forFeature('digital').afterEnable();

    expect(registry.stopFeature).toHaveBeenCalledWith('digital');
    expect(registry.resumeFeature).toHaveBeenCalledWith('digital');
  });
});
