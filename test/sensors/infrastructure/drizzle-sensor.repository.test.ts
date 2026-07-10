import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { sensors } from '../../../src/database/schema';
import { AppDatabase } from '../../../src/database/database.module';
import { DrizzleSensorRepository } from '../../../src/sensors/infrastructure/drizzle-sensor.repository';

let sqlite: Database.Database;
let db: AppDatabase;
let repo: DrizzleSensorRepository;

beforeEach(() => {
  sqlite = new Database(':memory:');
  db = drizzle(sqlite) as unknown as AppDatabase;
  migrate(db, { migrationsFolder: './migrations' });
  repo = new DrizzleSensorRepository(db);
});

describe('DrizzleSensorRepository', () => {
  it('loadEnabled returns only enabled rows mapped to the domain shape', async () => {
    db.insert(sensors)
      .values([
        {
          id: 'a',
          name: 'A',
          type: 'digital',
          enabled: true,
          config: { pin: 17 },
          debounceMs: 100,
          severity: 'warning',
        },
        {
          id: 'b',
          name: 'B',
          type: 'digital',
          enabled: false,
          config: { pin: 18 },
        },
      ])
      .run();

    const result = await repo.loadEnabled();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'a',
      name: 'A',
      type: 'digital',
      enabled: true,
      config: { pin: 17 },
      debounceMs: 100,
      severity: 'warning',
    });
  });

  it('uses the digital default when a legacy row has no debounce value', async () => {
    db.insert(sensors)
      .values({
        id: 'legacy',
        name: 'Legacy',
        type: 'digital',
        enabled: true,
        config: { pin: 17 },
        debounceMs: null,
        severity: 'info',
      })
      .run();

    await expect(repo.loadEnabled()).resolves.toEqual([
      expect.objectContaining({ id: 'legacy', debounceMs: 100 }),
    ]);
  });

  it('updateState writes lastValue / lastValueAt / updatedAt', async () => {
    db.insert(sensors)
      .values({ id: 'a', name: 'A', type: 'digital', enabled: true, config: { pin: 17 } })
      .run();
    const at = new Date('2030-01-01T00:00:00.000Z');

    await repo.updateState('a', 'true', at);

    const row = db.select().from(sensors).all()[0];
    expect(row.lastValue).toBe('true');
    expect(row.lastValueAt?.toISOString()).toBe(at.toISOString());
    expect(row.updatedAt).toBeInstanceOf(Date);
  });
});
