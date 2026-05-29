import { describe, expect, it, vi } from 'vitest';
import { SimulateSensorUseCase } from '../../../src/sensors/application/simulate-sensor.use-case';
import { SensorRegistryService } from '../../../src/sensors/application/sensor-registry.service';
import { SensorNotSimulatableError } from '../../../src/sensors/domain/errors/sensor-not-simulatable.error';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { InMemorySensorRepository } from '../../../src/sensors/infrastructure/in-memory-sensor.repository';
import { MockGpioAdapter } from '../../../src/sensors/infrastructure/mock-gpio.adapter';

function digitalSensor(over: Partial<Sensor> = {}): Sensor {
  return {
    id: 'front_door',
    name: 'Front door',
    type: 'digital',
    config: { pin: 17 },
    enabled: true,
    debounceMs: 0,
    severity: 'warning',
    lastValue: null,
    lastValueAt: null,
    ...over,
  };
}

describe('SimulateSensorUseCase', () => {
  it('drives the live mock driver, firing the real event pipeline', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    const registry = new SensorRegistryService(repo, () => driver);
    const listener = vi.fn();
    registry.onEvent(listener);
    await registry.reload();

    new SimulateSensorUseCase(registry).execute('front_door', 1);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        sensorId: 'front_door',
        type: 'state_change',
        oldValue: 0,
        newValue: 1,
      }),
    );
  });

  it('treats any value >= 1 as HIGH and 0 as LOW', async () => {
    const repo = new InMemorySensorRepository([digitalSensor()]);
    const driver = new MockGpioAdapter();
    const registry = new SensorRegistryService(repo, () => driver);
    await registry.reload();
    const useCase = new SimulateSensorUseCase(registry);

    useCase.execute('front_door', 5);
    expect(driver.getState().value).toBe(1);

    useCase.execute('front_door', 0);
    expect(driver.getState().value).toBe(0);
  });

  it('throws when the sensor is not active', () => {
    const repo = new InMemorySensorRepository([]);
    const registry = new SensorRegistryService(repo, () => new MockGpioAdapter());
    const useCase = new SimulateSensorUseCase(registry);

    expect(() => useCase.execute('ghost', 1)).toThrow(SensorNotSimulatableError);
  });
});
