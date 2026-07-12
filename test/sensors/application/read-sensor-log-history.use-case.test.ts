import { describe, expect, it } from 'vitest';
import { SensorNotFoundError } from '../../../src/sensors/domain/errors/sensor-not-found.error';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { ReadSensorLogHistoryUseCase } from '../../../src/sensors/application/read-sensor-log-history.use-case';
import { InMemorySensorLogExportReader } from '../../../src/sensors/infrastructure/in-memory-sensor-log-export.reader';
import { InMemorySensorQuery } from '../../../src/sensors/infrastructure/in-memory-sensor.query';

function sensor(input: Partial<Sensor> & Pick<Sensor, 'id' | 'name'>): Sensor {
  return {
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 100,
    severity: 'info',
    lastValue: null,
    lastValueAt: null,
    ...input,
  };
}

describe('ReadSensorLogHistoryUseCase', () => {
  it('resolves a name active-first and delegates its id to the reader', async () => {
    const query = new InMemorySensorQuery(
      [sensor({ id: 'current', name: 'door' })],
      [{ id: 'archived', name: 'door', type: 'uart', archivedAt: new Date('2030-01-01T00:00:00Z') }],
    );
    const reader = new InMemorySensorLogExportReader([
      { id: 1, sensorId: 'current', level: 'info', message: 'current', timestamp: new Date('2030-01-01T00:00:00Z') },
      { id: 2, sensorId: 'archived', level: 'info', message: 'archived', timestamp: new Date('2030-01-01T00:00:00Z') },
    ]);
    const useCase = new ReadSensorLogHistoryUseCase(query, reader);
    const messages: string[] = [];

    await useCase.execute({
      target: { kind: 'name', name: 'door' },
      limit: 100,
      maxMessageBytes: 256 * 1024,
      consume: (_sensor, rows) => {
        for (const row of rows) messages.push(row.message);
      },
    });

    expect(messages).toEqual(['current']);
  });

  it('resolves an archived target by id', async () => {
    const query = new InMemorySensorQuery([], [
      { id: 'archived', name: 'old door', type: 'digital', archivedAt: new Date('2030-01-01T00:00:00Z') },
    ]);
    const reader = new InMemorySensorLogExportReader([
      { id: 1, sensorId: 'archived', level: 'warn', message: 'historical', timestamp: new Date('2030-01-01T00:00:00Z') },
    ]);
    const useCase = new ReadSensorLogHistoryUseCase(query, reader);
    const resolved: string[] = [];

    await useCase.execute({
      target: { kind: 'id', id: 'archived' },
      limit: 100,
      maxMessageBytes: 256 * 1024,
      consume: (target, rows) => {
        resolved.push(target.name);
        expect([...rows].map((row) => row.message)).toEqual(['historical']);
      },
    });

    expect(resolved).toEqual(['old door']);
  });

  it('throws a typed error when the target is missing', async () => {
    const useCase = new ReadSensorLogHistoryUseCase(
      new InMemorySensorQuery(),
      new InMemorySensorLogExportReader(),
    );

    await expect(
      useCase.execute({
        target: { kind: 'name', name: 'missing' },
        limit: 100,
        maxMessageBytes: 256 * 1024,
        consume: () => undefined,
      }),
    ).rejects.toThrow(SensorNotFoundError);
  });

  it('rejects a thenable consumer before the reader transaction can commit', async () => {
    const useCase = new ReadSensorLogHistoryUseCase(
      new InMemorySensorQuery([sensor({ id: 's1', name: 'door' })]),
      new InMemorySensorLogExportReader([
        { id: 1, sensorId: 's1', level: 'info', message: 'row', timestamp: new Date('2030-01-01T00:00:00Z') },
      ]),
    );

    await expect(
      useCase.execute({
        target: { kind: 'id', id: 's1' },
        limit: 100,
        maxMessageBytes: 256 * 1024,
        consume: () => ({ then: () => undefined }),
      }),
    ).rejects.toThrow('synchronous');
  });
});
