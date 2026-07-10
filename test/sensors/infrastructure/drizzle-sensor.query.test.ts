import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensors } from '../../../src/database/schema';
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
});
