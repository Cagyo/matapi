import { describe, expect, it } from 'vitest';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { InMemorySensorQuery } from '../../../src/sensors/infrastructure/in-memory-sensor.query';

function sensor(id: string, name: string, enabled = true): Sensor {
  return {
    id,
    name,
    type: 'digital',
    config: {},
    enabled,
    debounceMs: 100,
    severity: 'info',
    lastValue: null,
    lastValueAt: null,
  };
}

describe('InMemorySensorQuery', () => {
  it('builds dashboard pages from enabled sensors only', async () => {
    const query = new InMemorySensorQuery([
      ...Array.from({ length: 9 }, (_, index) => sensor(`id-${index}`, `Sensor ${index}`)),
      sensor('disabled', 'A disabled sensor', false),
    ]);

    await expect(query.listDashboardPage({ page: 1, pageSize: 8 })).resolves.toMatchObject({
      total: 9,
      page: 1,
      pageCount: 2,
      sensors: [{ id: 'id-8' }],
    });
  });
});
