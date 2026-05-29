import { describe, expect, it } from 'vitest';
import { UnmuteSensorUseCase } from '../../../src/telegram/application/unmute-sensor.use-case';
import { SensorNotFoundError } from '../../../src/telegram/domain/errors/sensor-not-found.error';
import { SensorNotMutedError } from '../../../src/telegram/domain/errors/sensor-not-muted.error';
import { InMemoryUserSensorMuteRepository } from '../../../src/telegram/infrastructure/in-memory-user-sensor-mute.repository';
import { Sensor } from '../../../src/sensors/domain/sensor';
import {
  SensorLookup,
  SensorQueryPort,
} from '../../../src/sensors/domain/ports/sensor-query.port';

function activeSensor(id: string, name: string): Sensor {
  return {
    id,
    name,
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 10_000,
    severity: 'info',
    lastValue: null,
    lastValueAt: null,
  };
}

function makeQuery(map: Map<string, SensorLookup>): SensorQueryPort {
  return {
    listEnabled: async () => [],
    findById: async () => null,
    findByName: async (name) => map.get(name.toLowerCase()) ?? null,
  };
}

describe('UnmuteSensorUseCase', () => {
  it('unmutes a previously muted sensor', async () => {
    const sensor = activeSensor('door-1', 'door_1');
    const query = makeQuery(
      new Map([['door_1', { kind: 'active', sensor } as SensorLookup]]),
    );
    const mutes = new InMemoryUserSensorMuteRepository();
    await mutes.mute(42, 'door-1');
    const useCase = new UnmuteSensorUseCase(query, mutes);

    await useCase.execute(42, 'door_1');

    expect(await mutes.isMuted(42, 'door-1')).toBe(false);
  });

  it('throws SensorNotFoundError for unknown sensor', async () => {
    const useCase = new UnmuteSensorUseCase(
      makeQuery(new Map()),
      new InMemoryUserSensorMuteRepository(),
    );
    await expect(useCase.execute(42, 'ghost')).rejects.toBeInstanceOf(
      SensorNotFoundError,
    );
  });

  it('throws SensorNotMutedError when the sensor was not muted', async () => {
    const sensor = activeSensor('door-1', 'door_1');
    const query = makeQuery(
      new Map([['door_1', { kind: 'active', sensor } as SensorLookup]]),
    );
    const useCase = new UnmuteSensorUseCase(
      query,
      new InMemoryUserSensorMuteRepository(),
    );

    await expect(useCase.execute(42, 'door_1')).rejects.toBeInstanceOf(
      SensorNotMutedError,
    );
  });
});
