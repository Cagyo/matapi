import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/database/schema';
import { DevSeederService } from '../../../src/sensors/application/dev-seeder.service';
import { SensorRegistryService } from '../../../src/sensors/application/sensor-registry.service';

describe('DevSeederService', () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let mockRegistry: SensorRegistryService;
  let seeder: DevSeederService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve('./migrations') });

    mockRegistry = {
      reload: vi.fn().mockResolvedValue(undefined),
    } as unknown as SensorRegistryService;

    seeder = new DevSeederService(db, mockRegistry);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('seeds representative dev state from dev-state.yml when tables are empty', async () => {
    const res = await seeder.seed({ reset: false, configPath: './config/dev-state.yml' });

    expect(res.ok).toBe(true);
    expect(res.sensors).toBeGreaterThan(0);
    expect(res.cameras).toBeGreaterThan(0);
    expect(res.users).toBeGreaterThan(0);

    const allSensors = db.select().from(schema.sensors).all();
    expect(allSensors.length).toBe(res.sensors);
    expect(allSensors.some((s) => s.id === 'door_1')).toBe(true);
    expect(allSensors.some((s) => s.id === 'co2')).toBe(true);

    expect(mockRegistry.reload).toHaveBeenCalledTimes(1);
  });

  it('resets existing database records when reset is true', async () => {
    // Initial seed
    await seeder.seed({ reset: false, configPath: './config/dev-state.yml' });

    // Insert dummy sensor not in dev-state.yml
    db.insert(schema.sensors)
      .values({
        id: 'old_dummy_sensor',
        name: 'old_dummy_sensor',
        type: 'digital',
      })
      .run();

    expect(db.select().from(schema.sensors).all().some((s) => s.id === 'old_dummy_sensor')).toBe(true);

    // Reset seed
    const res = await seeder.seed({ reset: true, configPath: './config/dev-state.yml' });
    expect(res.ok).toBe(true);

    const allSensors = db.select().from(schema.sensors).all();
    expect(allSensors.some((s) => s.id === 'old_dummy_sensor')).toBe(false);
    expect(allSensors.some((s) => s.id === 'door_1')).toBe(true);
    expect(mockRegistry.reload).toHaveBeenCalledTimes(2);
  });
});
