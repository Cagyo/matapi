import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleSensorLogRepository } from '../../../src/sensors/infrastructure/drizzle-sensor-log.repository';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

describe('DrizzleSensorLogRepository', () => {
  let context: TestDatabaseContext;
  let repo: DrizzleSensorLogRepository;

  beforeEach(() => {
    context = createTestDatabase();
    repo = new DrizzleSensorLogRepository(context.appDb);
  });

  afterEach(() => context.close());

  it('returns recent entries newest first, limited', async () => {
    await repo.appendBatch([
      { sensorId: 's1', level: 'info', message: 'a', timestamp: new Date('2030-01-01T00:00:00Z') },
      { sensorId: 's1', level: 'warn', message: 'b', timestamp: new Date('2030-01-02T00:00:00Z') },
      { sensorId: 's1', level: 'error', message: 'c', timestamp: new Date('2030-01-03T00:00:00Z') },
      { sensorId: 's2', level: 'info', message: 'noise', timestamp: new Date('2030-01-04T00:00:00Z') },
    ]);

    const rows = await repo.findRecent('s1', { limit: 2 });
    expect(rows.map((r) => r.message)).toEqual(['c', 'b']);
  });

  it('filters by `since` when provided', async () => {
    await repo.appendBatch([
      { sensorId: 's1', level: 'info', message: 'old', timestamp: new Date('2030-01-01T00:00:00Z') },
      { sensorId: 's1', level: 'info', message: 'new', timestamp: new Date('2030-01-05T00:00:00Z') },
    ]);

    const rows = await repo.findRecent('s1', {
      limit: 10,
      since: new Date('2030-01-03T00:00:00Z'),
    });
    expect(rows.map((r) => r.message)).toEqual(['new']);
  });

  it('returns an empty list for unknown sensors', async () => {
    expect(await repo.findRecent('nope', { limit: 5 })).toEqual([]);
  });
});
