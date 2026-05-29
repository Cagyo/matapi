import { describe, expect, it, vi } from 'vitest';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';
import { ModifySensorUseCase } from '../../../src/sensors/application/modify-sensor.use-case';
import { ReloadSensorsUseCase } from '../../../src/sensors/application/reload-sensors.use-case';
import { PinAlreadyInUseError } from '../../../src/sensors/domain/errors/pin-already-in-use.error';
import { SensorNameExistsError } from '../../../src/sensors/domain/errors/sensor-name-exists.error';
import { SensorNotFoundError } from '../../../src/sensors/domain/errors/sensor-not-found.error';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { InMemorySensorRepository } from '../../../src/sensors/infrastructure/in-memory-sensor.repository';

const clock: ClockPort = { now: () => new Date('2030-02-01T00:00:00.000Z') };

function digital(id: string, name: string, pin: number): Sensor {
  return {
    id,
    name,
    type: 'digital',
    config: { pin, activeLow: true, pull: 'up' },
    enabled: true,
    debounceMs: 10_000,
    severity: 'info',
    lastValue: null,
    lastValueAt: null,
  };
}

function makeUseCase(seed: Sensor[] = []) {
  const repo = new InMemorySensorRepository(seed);
  const reload = {
    execute: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReloadSensorsUseCase;
  return { useCase: new ModifySensorUseCase(repo, clock, reload), repo, reload };
}

describe('ModifySensorUseCase', () => {
  it('updates severity and triggers reload', async () => {
    const { useCase, repo, reload } = makeUseCase([digital('a', 'front_door', 17)]);
    await useCase.execute({
      currentName: 'front_door',
      patch: { severity: 'critical' },
    });
    expect((await repo.findByName('front_door'))?.severity).toBe('critical');
    expect(reload.execute).toHaveBeenCalledOnce();
  });

  it('renames a sensor when the new name is free', async () => {
    const { useCase, repo } = makeUseCase([digital('a', 'old_name', 17)]);
    await useCase.execute({ currentName: 'old_name', patch: { name: 'new_name' } });
    expect(await repo.findByName('new_name')).not.toBeNull();
    expect(await repo.findByName('old_name')).toBeNull();
  });

  it('rejects a rename that collides with another sensor', async () => {
    const { useCase } = makeUseCase([
      digital('a', 'door_a', 17),
      digital('b', 'door_b', 18),
    ]);
    await expect(
      useCase.execute({ currentName: 'door_a', patch: { name: 'door_b' } }),
    ).rejects.toBeInstanceOf(SensorNameExistsError);
  });

  it('rejects a pin change that collides with another active digital sensor', async () => {
    const { useCase } = makeUseCase([
      digital('a', 'door_a', 17),
      digital('b', 'door_b', 18),
    ]);
    await expect(
      useCase.execute({
        currentName: 'door_a',
        patch: { config: { pin: 18, activeLow: true, pull: 'up' } },
      }),
    ).rejects.toBeInstanceOf(PinAlreadyInUseError);
  });

  it('throws SensorNotFoundError when the name is unknown', async () => {
    const { useCase } = makeUseCase();
    await expect(
      useCase.execute({ currentName: 'ghost', patch: { severity: 'info' } }),
    ).rejects.toBeInstanceOf(SensorNotFoundError);
  });
});
