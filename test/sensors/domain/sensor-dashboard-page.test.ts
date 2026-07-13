import { describe, expect, it } from 'vitest';
import { buildSensorDashboardPage } from '../../../src/sensors/domain/sensor-dashboard-page';
import { Sensor } from '../../../src/sensors/domain/sensor';

function sensor(id: string, name: string): Sensor {
  return {
    id,
    name,
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 100,
    severity: 'info',
    lastValue: null,
    lastValueAt: null,
  };
}

describe('buildSensorDashboardPage', () => {
  it('sorts normalized names by direct Unicode code point and breaks ties by immutable id', () => {
    const sensors = [
      sensor('z-id', '  Zebra '),
      sensor('b-id', 'A\u030A'),
      sensor('a-id', '\u00C5'),
      sensor('uk-id', '\u0411\u0430\u043b\u043a\u043e\u043d'),
      sensor('ascii-id', 'apple'),
    ];

    expect(buildSensorDashboardPage(sensors, { page: 0, pageSize: 8 }).sensors.map((item) => item.id))
      .toEqual(['ascii-id', 'z-id', 'a-id', 'b-id', 'uk-id']);
  });

  it('returns eight rows per page', () => {
    const sensors = Array.from({ length: 9 }, (_, index) => sensor(`id-${index}`, `Sensor ${index}`));

    expect(buildSensorDashboardPage(sensors, { page: 0, pageSize: 8 })).toMatchObject({
      total: 9,
      page: 0,
      pageCount: 2,
      clamped: false,
      sensors: expect.arrayContaining([expect.objectContaining({ id: 'id-0' })]),
    });
    expect(buildSensorDashboardPage(sensors, { page: 0, pageSize: 8 }).sensors).toHaveLength(8);
    expect(buildSensorDashboardPage(sensors, { page: 1, pageSize: 8 }).sensors).toHaveLength(1);
  });

  it('returns an empty zero page for no sensors', () => {
    expect(buildSensorDashboardPage([], { page: 0, pageSize: 8 })).toEqual({
      sensors: [],
      requestedPage: 0,
      page: 0,
      pageCount: 0,
      total: 0,
      clamped: false,
    });
  });

  it('clamps a negative requested page to zero', () => {
    const result = buildSensorDashboardPage([sensor('id', 'Sensor')], { page: -4, pageSize: 8 });

    expect(result).toMatchObject({ requestedPage: -4, page: 0, clamped: true });
  });

  it('clamps an oversized requested page to the last page', () => {
    const sensors = Array.from({ length: 9 }, (_, index) => sensor(`id-${index}`, `Sensor ${index}`));

    expect(buildSensorDashboardPage(sensors, { page: 99, pageSize: 8 })).toMatchObject({
      requestedPage: 99,
      page: 1,
      pageCount: 2,
      clamped: true,
    });
  });
});
