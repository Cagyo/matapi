import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { SimulateSensorUseCase } from '../../../src/sensors/application/simulate-sensor.use-case';
import { SensorRegistryService } from '../../../src/sensors/application/sensor-registry.service';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { SensorQueryPort } from '../../../src/sensors/domain/ports/sensor-query.port';
import { InMemorySensorRepository } from '../../../src/sensors/infrastructure/in-memory-sensor.repository';
import { MockGpioAdapter } from '../../../src/sensors/infrastructure/mock-gpio.adapter';
import { DevSimulatorController } from '../../../src/sensors/interfaces/dev-simulator.controller';

function digitalSensor(): Sensor {
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
  };
}

function queryStub(sensors: Sensor[]): SensorQueryPort {
  return {
    listEnabled: async () => sensors,
    findById: async () => null,
    findByName: async () => null,
  };
}

async function build(sensors: Sensor[]) {
  const repo = new InMemorySensorRepository(sensors);
  const registry = new SensorRegistryService(repo, () => new MockGpioAdapter());
  await registry.reload();
  const controller = new DevSimulatorController(
    new SimulateSensorUseCase(registry),
    queryStub(sensors),
  );
  return { controller, registry };
}

describe('DevSimulatorController', () => {
  it('renders a panel row with the sensor name and pin', async () => {
    const { controller } = await build([digitalSensor()]);

    const html = await controller.panel();

    expect(html).toContain('Home Worker — Dev Simulator');
    expect(html).toContain('Front door');
    expect(html).toContain('GPIO 17');
    expect(html).toContain("setDigital('front_door', 1)");
  });

  it('shows the empty state when no simulatable sensors exist', async () => {
    const { controller } = await build([]);

    const html = await controller.panel();

    expect(html).toContain('No simulatable sensors configured');
  });

  it('acks a digital simulate and reflects HIGH on the driver', async () => {
    const { controller, registry } = await build([digitalSensor()]);

    const ack = controller.digital({ id: 'front_door', value: 1 });

    expect(ack).toEqual({ ok: true, id: 'front_door', value: 1 });
    expect(registry.getDriver('front_door')?.getState().value).toBe(1);
  });

  it('rejects a request with no sensor id', async () => {
    const { controller } = await build([digitalSensor()]);

    expect(() => controller.digital({ value: 1 })).toThrow(BadRequestException);
  });

  it('rejects simulating an unknown sensor', async () => {
    const { controller } = await build([digitalSensor()]);

    expect(() => controller.digital({ id: 'ghost', value: 1 })).toThrow(
      BadRequestException,
    );
  });

  it('clamps CO2 ppm into the 400–2000 range', async () => {
    const { controller, registry } = await build([
      { ...digitalSensor(), id: 'co2_1', name: 'CO2', type: 'uart', config: {} },
    ]);
    // Replace the digital mock with one that records simulate() input.
    const calls: number[] = [];
    const driver = registry.getDriver('co2_1');
    if (driver) (driver as { simulate: (v: number) => void }).simulate = (v) => calls.push(v);

    controller.co2({ id: 'co2_1', ppm: 99999 });
    controller.co2({ id: 'co2_1', ppm: 100 });

    expect(calls).toEqual([2000, 400]);
  });
});
