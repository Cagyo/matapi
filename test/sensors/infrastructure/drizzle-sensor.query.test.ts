import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensors, sensorsArchive } from '../../../src/database/schema';
import { DrizzleSensorQuery } from '../../../src/sensors/infrastructure/drizzle-sensor.query';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

describe('DrizzleSensorQuery', () => {
  let context: TestDatabaseContext;
  let query: DrizzleSensorQuery;

  beforeEach(() => {
    context = createTestDatabase();
    query = new DrizzleSensorQuery(context.appDb);

    context.db
      .insert(sensors)
      .values([
        {
          id: 'front_door',
          name: 'Front door',
          type: 'digital',
          config: { pin: 17 },
          enabled: true,
          debounceMs: 5000,
          severity: 'warning',
        },
        {
          id: 'archived',
          name: 'Archived sensor',
          type: 'digital',
          config: {},
          enabled: false,
          severity: 'info',
        },
        {
          id: 'legacy_digital',
          name: 'Legacy digital',
          type: 'digital',
          config: { pin: 18 },
          enabled: true,
          debounceMs: null,
          severity: 'info',
        },
      ])
      .run();
  });

  afterEach(() => context.close());

  it('lists only enabled sensors', async () => {
    const result = await query.listEnabled();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 'front_door',
      name: 'Front door',
      type: 'digital',
      severity: 'warning',
      debounceMs: 5000,
    });
  });

  it('builds dashboard pages from enabled rows only', async () => {
    context.db.delete(sensors).run();
    context.db
      .insert(sensors)
      .values([
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `sensor-${index}`,
          name: `Sensor ${index}`,
          type: 'digital' as const,
          config: {},
          enabled: true,
          severity: 'info' as const,
        })),
        {
          id: 'disabled',
          name: 'A disabled sensor',
          type: 'digital' as const,
          config: {},
          enabled: false,
          severity: 'info' as const,
        },
      ])
      .run();

    await expect(query.listDashboardPage({ page: 1, pageSize: 8 })).resolves.toMatchObject({
      total: 9,
      page: 1,
      pageCount: 2,
      sensors: [{ id: 'sensor-8' }],
    });
  });

  it('returns the sensor by id when enabled', async () => {
    const sensor = await query.findById('front_door');
    expect(sensor).toMatchObject({ id: 'front_door', name: 'Front door' });
  });

  it('uses the digital default for legacy rows with no debounce value', async () => {
    await expect(query.findById('legacy_digital')).resolves.toMatchObject({
      debounceMs: 100,
    });
  });

  it('returns null for disabled or unknown sensors', async () => {
    expect(await query.findById('archived')).toBeNull();
    expect(await query.findById('unknown')).toBeNull();
  });

  it('resolves disabled and archived sensors by ID for historical log links', async () => {
    context.db
      .insert(sensorsArchive)
      .values({
        id: 'removed',
        name: 'Removed sensor',
        type: 'digital',
        config: {},
        archivedAt: new Date('2026-07-11T08:00:00Z'),
      })
      .run();

    await expect(query.findByIdIncludingArchived('archived')).resolves.toMatchObject({
      kind: 'active',
      sensor: { id: 'archived', name: 'Archived sensor', enabled: false },
    });
    await expect(query.findByIdIncludingArchived('removed')).resolves.toMatchObject({
      kind: 'archived',
      sensor: { id: 'removed', name: 'Removed sensor' },
    });
  });

  it('lists current targets before archived targets by case-insensitive name and id', async () => {
    context.db.delete(sensors).run();
    context.db
      .insert(sensors)
      .values([
        {
          id: 'z-current',
          name: 'Bravo',
          type: 'digital',
          config: {},
          enabled: true,
        },
        {
          id: 'a-disabled',
          name: 'alpha',
          type: 'digital',
          config: {},
          enabled: false,
        },
        {
          id: 'a-current',
          name: 'bravo',
          type: 'digital',
          config: {},
          enabled: true,
        },
      ])
      .run();
    context.db
      .insert(sensorsArchive)
      .values({
        id: 'a-archive',
        name: 'Aaron',
        type: 'uart',
        config: {},
        archivedAt: new Date('2026-07-11T08:00:00Z'),
      })
      .run();

    await expect(query.listHistoryTargets({ page: 0, pageSize: 20 })).resolves.toEqual({
      page: 0,
      pageCount: 1,
      targets: [
        {
          id: 'a-disabled',
          name: 'alpha',
          type: 'digital',
          enabled: false,
          state: 'current',
          archivedAt: null,
        },
        {
          id: 'a-current',
          name: 'bravo',
          type: 'digital',
          enabled: true,
          state: 'current',
          archivedAt: null,
        },
        {
          id: 'z-current',
          name: 'Bravo',
          type: 'digital',
          enabled: true,
          state: 'current',
          archivedAt: null,
        },
        {
          id: 'a-archive',
          name: 'Aaron',
          type: 'uart',
          enabled: false,
          state: 'archived',
          archivedAt: new Date('2026-07-11T08:00:00Z'),
        },
      ],
    });
  });

  it('returns the requested target page and page count', async () => {
    await expect(query.listHistoryTargets({ page: 1, pageSize: 2 })).resolves.toMatchObject({
      page: 1,
      pageCount: 2,
      targets: [{ id: 'legacy_digital' }],
    });
  });
});
