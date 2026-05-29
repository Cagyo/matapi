import { describe, expect, it, vi } from 'vitest';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';
import { AddSensorUseCase } from '../../../src/sensors/application/add-sensor.use-case';
import { ReloadSensorsUseCase } from '../../../src/sensors/application/reload-sensors.use-case';
import { InvalidGpioPinError } from '../../../src/sensors/domain/errors/invalid-gpio-pin.error';
import { InvalidSensorNameError } from '../../../src/sensors/domain/errors/invalid-sensor-name.error';
import { PinAlreadyInUseError } from '../../../src/sensors/domain/errors/pin-already-in-use.error';
import { SensorNameExistsError } from '../../../src/sensors/domain/errors/sensor-name-exists.error';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { InMemorySensorRepository } from '../../../src/sensors/infrastructure/in-memory-sensor.repository';

const clock: ClockPort = { now: () => new Date('2030-01-01T00:00:00.000Z') };

function makeUseCase(seed: Sensor[] = []): {
  useCase: AddSensorUseCase;
  repo: InMemorySensorRepository;
  reload: ReloadSensorsUseCase;
} {
  const repo = new InMemorySensorRepository(seed);
  const reload = {
    execute: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReloadSensorsUseCase;
  const useCase = new AddSensorUseCase(repo, clock, reload);
  return { useCase, repo, reload };
}

const digitalInput = {
  name: 'front_door',
  type: 'digital' as const,
  config: { pin: 17, activeLow: true, pull: 'up' as const },
  debounceMs: 10_000,
  severity: 'info' as const,
};

describe('AddSensorUseCase', () => {
  it('persists a new digital sensor and triggers reload', async () => {
    const { useCase, repo, reload } = makeUseCase();

    const created = await useCase.execute(digitalInput);

    expect(created.name).toBe('front_door');
    expect(created.id).toBeDefined();
    expect(await repo.findByName('front_door')).not.toBeNull();
    expect(reload.execute).toHaveBeenCalledOnce();
  });

  it('rejects an invalid sensor name', async () => {
    const { useCase } = makeUseCase();
    await expect(
      useCase.execute({ ...digitalInput, name: 'bad name!' }),
    ).rejects.toBeInstanceOf(InvalidSensorNameError);
  });

  it('rejects a duplicate sensor name', async () => {
    const { useCase, repo } = makeUseCase();
    await useCase.execute(digitalInput);
    await expect(
      useCase.execute({ ...digitalInput, config: { ...digitalInput.config, pin: 18 } }),
    ).rejects.toBeInstanceOf(SensorNameExistsError);
    expect((await repo.loadEnabled()).length).toBe(1);
  });

  it('rejects an out-of-range GPIO pin', async () => {
    const { useCase } = makeUseCase();
    await expect(
      useCase.execute({ ...digitalInput, config: { ...digitalInput.config, pin: 99 } }),
    ).rejects.toBeInstanceOf(InvalidGpioPinError);
  });

  it('rejects a pin already in use by another sensor', async () => {
    const { useCase } = makeUseCase();
    await useCase.execute(digitalInput);
    await expect(
      useCase.execute({ ...digitalInput, name: 'other_door' }),
    ).rejects.toBeInstanceOf(PinAlreadyInUseError);
  });

  it('persists a UART sensor without pin validation', async () => {
    const { useCase, repo } = makeUseCase();
    await useCase.execute({
      name: 'co2_living',
      type: 'uart',
      config: {
        port: '/dev/ttyS0',
        baudRate: 9600,
        thresholds: { warning: 800, critical: 1200 },
      },
      debounceMs: 0,
      severity: 'warning',
    });
    const stored = await repo.findByName('co2_living');
    expect(stored?.type).toBe('uart');
  });
});
