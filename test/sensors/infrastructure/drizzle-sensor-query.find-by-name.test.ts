import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensors, sensorsArchive } from '../../../src/database/schema';
import { DrizzleSensorQuery } from '../../../src/sensors/infrastructure/drizzle-sensor.query';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

describe('DrizzleSensorQuery.findByName', () => {
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
          name: 'front_door',
          type: 'digital',
          config: { pin: 17 },
          enabled: true,
          debounceMs: 5000,
          severity: 'warning',
        },
      ])
      .run();

    context.db
      .insert(sensorsArchive)
      .values([
        {
          id: 'old_door',
          name: 'old_door',
          type: 'digital',
          config: {},
          severity: 'info',
          archivedAt: new Date('2030-01-01T00:00:00.000Z'),
        },
      ])
      .run();
  });

  afterEach(() => context.close());

  it('resolves an active sensor by name', async () => {
    const lookup = await query.findByName('front_door');
    expect(lookup?.kind).toBe('active');
    expect(lookup?.sensor.id).toBe('front_door');
  });

  it('falls back to the archive when the name is no longer active', async () => {
    const lookup = await query.findByName('old_door');
    expect(lookup?.kind).toBe('archived');
    expect(lookup?.sensor.id).toBe('old_door');
  });

  it('returns null when no sensor matches', async () => {
    expect(await query.findByName('ghost')).toBeNull();
  });
});
