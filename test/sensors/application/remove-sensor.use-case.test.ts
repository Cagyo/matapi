import { describe, expect, it, vi } from 'vitest';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';
import { ReloadSensorsUseCase } from '../../../src/sensors/application/reload-sensors.use-case';
import { RemoveSensorUseCase } from '../../../src/sensors/application/remove-sensor.use-case';
import { SensorNotFoundError } from '../../../src/sensors/domain/errors/sensor-not-found.error';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { InMemorySensorRepository } from '../../../src/sensors/infrastructure/in-memory-sensor.repository';

const clock: ClockPort = { now: () => new Date('2030-03-01T00:00:00.000Z') };

const seedDoor: Sensor = {
  id: 'door-1',
  name: 'front_door',
  type: 'digital',
  config: { pin: 17 },
  enabled: true,
  debounceMs: 10_000,
  severity: 'info',
  lastValue: null,
  lastValueAt: null,
};

describe('RemoveSensorUseCase', () => {
  it('archives a sensor by name and triggers reload', async () => {
    const repo = new InMemorySensorRepository([seedDoor]);
    const reload = {
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReloadSensorsUseCase;
    const useCase = new RemoveSensorUseCase(repo, clock, reload);

    await useCase.execute('front_door');

    expect(await repo.findByName('front_door')).toBeNull();
    expect(repo.listArchived()).toEqual([
      { id: 'door-1', name: 'front_door', archivedAt: clock.now() },
    ]);
    expect(reload.execute).toHaveBeenCalledOnce();
  });

  it('throws SensorNotFoundError when the name is unknown', async () => {
    const repo = new InMemorySensorRepository();
    const useCase = new RemoveSensorUseCase(repo, clock, {
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReloadSensorsUseCase);

    await expect(useCase.execute('ghost')).rejects.toBeInstanceOf(SensorNotFoundError);
  });
});
