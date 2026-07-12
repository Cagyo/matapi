import { describe, expect, it } from 'vitest';
import { ListSensorHistoryTargetsUseCase } from '../../../src/sensors/application/list-sensor-history-targets.use-case';
import { Sensor } from '../../../src/sensors/domain/sensor';
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

describe('ListSensorHistoryTargetsUseCase', () => {
  it('returns current sensors before archives, ordered by name then id', async () => {
    const query = new InMemorySensorQuery(
      [
        sensor({ id: 'z-current', name: 'Bravo' }),
        sensor({ id: 'a-disabled', name: 'alpha', enabled: false }),
        sensor({ id: 'a-current', name: 'bravo' }),
      ],
      [
        {
          id: 'a-archive',
          name: 'Aaron',
          type: 'uart',
          archivedAt: new Date('2026-07-11T08:00:00Z'),
        },
      ],
    );
    const useCase = new ListSensorHistoryTargetsUseCase(query);

    await expect(useCase.execute({ page: 0, pageSize: 20 })).resolves.toMatchObject({
      page: 0,
      pageCount: 1,
      targets: [
        { id: 'a-disabled', type: 'digital', state: 'current' },
        { id: 'a-current', type: 'digital', state: 'current' },
        { id: 'z-current', type: 'digital', state: 'current' },
        { id: 'a-archive', type: 'uart', state: 'archived' },
      ],
    });
  });

  it('clamps a stale page to the final available page', async () => {
    const query = new InMemorySensorQuery([
      sensor({ id: 'one', name: 'One' }),
      sensor({ id: 'two', name: 'Two' }),
      sensor({ id: 'three', name: 'Three' }),
    ]);
    const useCase = new ListSensorHistoryTargetsUseCase(query);

    await expect(useCase.execute({ page: 99, pageSize: 2 })).resolves.toMatchObject({
      page: 1,
      pageCount: 2,
      targets: [{ id: 'two' }],
    });
  });

  it.each([
    { page: -1, pageSize: 20 },
    { page: 0.5, pageSize: 20 },
    { page: 0, pageSize: 0 },
    { page: 0, pageSize: -1 },
    { page: 0, pageSize: 1.5 },
  ])('rejects invalid pagination input %#', async (input) => {
    const useCase = new ListSensorHistoryTargetsUseCase(new InMemorySensorQuery());

    await expect(useCase.execute(input)).rejects.toThrow('Invalid pagination input');
  });

  it('returns the empty page contract for no targets', async () => {
    const useCase = new ListSensorHistoryTargetsUseCase(new InMemorySensorQuery());

    await expect(useCase.execute({ page: 5, pageSize: 20 })).resolves.toEqual({
      targets: [],
      page: 0,
      pageCount: 0,
    });
  });
});
