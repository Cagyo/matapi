import { describe, expect, it, vi } from 'vitest';
import { ReloadSensorsUseCase } from '../../../src/sensors/application/reload-sensors.use-case';
import { SensorRegistryService } from '../../../src/sensors/application/sensor-registry.service';

describe('ReloadSensorsUseCase', () => {
  it('delegates to SensorRegistryService.reload()', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    const registry = { reload } as unknown as SensorRegistryService;
    const useCase = new ReloadSensorsUseCase(registry);

    await useCase.execute();

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
