import { describe, expect, it } from 'vitest';
import { MuteSensorUseCase } from '../../../src/telegram/application/mute-sensor.use-case';
import { SensorAlreadyMutedError } from '../../../src/telegram/domain/errors/sensor-already-muted.error';
import { SensorNotFoundError } from '../../../src/telegram/domain/errors/sensor-not-found.error';
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
    findByIdIncludingArchived: async () => null,
    findByName: async (name) => map.get(name.toLowerCase()) ?? null,
    listHistoryTargets: async (input) => ({ targets: [], page: input.page, pageCount: 0 }),
  };
}

describe('MuteSensorUseCase', () => {
  it('mutes an active sensor for a user', async () => {
    const sensor = activeSensor('door-1', 'door_1');
    const query = makeQuery(
      new Map([['door_1', { kind: 'active', sensor }]]),
    );
    const mutes = new InMemoryUserSensorMuteRepository();
    const useCase = new MuteSensorUseCase(query, mutes);

    await useCase.execute(42, 'door_1');

    expect(await mutes.isMuted(42, 'door-1')).toBe(true);
  });

  it('throws SensorNotFoundError for unknown sensor', async () => {
    const useCase = new MuteSensorUseCase(
      makeQuery(new Map()),
      new InMemoryUserSensorMuteRepository(),
    );
    await expect(useCase.execute(42, 'ghost')).rejects.toBeInstanceOf(
      SensorNotFoundError,
    );
  });

  it('throws SensorNotFoundError when the sensor is archived', async () => {
    const query = makeQuery(
      new Map<string, SensorLookup>([
        [
          'door_1',
          {
            kind: 'archived',
            sensor: { id: 'door-1', name: 'door_1', type: 'digital', archivedAt: new Date() },
          },
        ],
      ]),
    );
    const useCase = new MuteSensorUseCase(
      query,
      new InMemoryUserSensorMuteRepository(),
    );
    await expect(useCase.execute(42, 'door_1')).rejects.toBeInstanceOf(
      SensorNotFoundError,
    );
  });

  it('throws SensorAlreadyMutedError when re-muting', async () => {
    const sensor = activeSensor('door-1', 'door_1');
    const query = makeQuery(
      new Map([['door_1', { kind: 'active', sensor }]]),
    );
    const mutes = new InMemoryUserSensorMuteRepository();
    await mutes.mute(42, 'door-1');
    const useCase = new MuteSensorUseCase(query, mutes);

    await expect(useCase.execute(42, 'door_1')).rejects.toBeInstanceOf(
      SensorAlreadyMutedError,
    );
  });

  it('mutes a camera when sensor lookup does not find an active sensor', async () => {
    const query = makeQuery(new Map());
    const mutes = new InMemoryUserSensorMuteRepository();
    const media = {
      listCameras: async () => [],
      findCameraByName: async (name: string) =>
        name === 'front_door_cam'
          ? { id: 'cam-1', name: 'front_door_cam', enabled: true }
          : null,
      saveCamera: async () => {},
      listSnapshots: async () => [],
      saveSnapshot: async () => ({
        id: '1',
        cameraId: 'cam-1',
        filePath: '',
        fileSize: 0,
        createdAt: new Date(),
      }),
      pruneSnapshotsBefore: async () => 0,
    };
    const useCase = new MuteSensorUseCase(query, mutes, media as any);

    await useCase.execute(42, 'front_door_cam');

    expect(await mutes.isMuted(42, 'cam-1')).toBe(true);
  });
});
