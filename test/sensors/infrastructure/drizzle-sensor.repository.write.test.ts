import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensors, sensorsArchive } from '../../../src/database/schema';
import { DrizzleSensorRepository } from '../../../src/sensors/infrastructure/drizzle-sensor.repository';
import { createTestDatabase, TestDatabaseContext } from '../../helpers/database';

describe('DrizzleSensorRepository — write surface (spec 10)', () => {
  let ctx: TestDatabaseContext;
  let repo: DrizzleSensorRepository;

  beforeEach(() => {
    ctx = createTestDatabase();
    repo = new DrizzleSensorRepository(ctx.appDb);
  });

  afterEach(() => ctx.close());

  it('create + findByName round-trip', async () => {
    await repo.create({
      id: 'door-1',
      name: 'front_door',
      type: 'digital',
      config: { pin: 17 },
      debounceMs: 5_000,
      severity: 'warning',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    const found = await repo.findByName('front_door');
    expect(found).toMatchObject({
      id: 'door-1',
      name: 'front_door',
      type: 'digital',
      severity: 'warning',
      debounceMs: 5_000,
    });
  });

  it('findActivePinOwner returns the sensor that owns the pin', async () => {
    await repo.create({
      id: 'a',
      name: 'door_a',
      type: 'digital',
      config: { pin: 17 },
      debounceMs: 0,
      severity: 'info',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const owner = await repo.findActivePinOwner(17);
    expect(owner?.name).toBe('door_a');
    expect(await repo.findActivePinOwner(18)).toBeNull();
  });

  it('update patches only the present fields', async () => {
    await repo.create({
      id: 'a',
      name: 'door_a',
      type: 'digital',
      config: { pin: 17 },
      debounceMs: 1_000,
      severity: 'info',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    const updated = await repo.update('a', {
      severity: 'critical',
      updatedAt: new Date('2030-02-01T00:00:00.000Z'),
    });

    expect(updated.severity).toBe('critical');
    expect(updated.name).toBe('door_a');
    expect(updated.debounceMs).toBe(1_000);
  });

  it('archive moves the row to sensors_archive atomically', async () => {
    await repo.create({
      id: 'a',
      name: 'old_door',
      type: 'digital',
      config: { pin: 17 },
      debounceMs: 0,
      severity: 'info',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const archivedAt = new Date('2030-04-01T00:00:00.000Z');

    await repo.archive('a', archivedAt);

    expect(ctx.db.select().from(sensors).all()).toHaveLength(0);
    const archived = ctx.db.select().from(sensorsArchive).all();
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      id: 'a',
      name: 'old_door',
      archivedAt,
    });
  });

  it('applyImport archives, updates and inserts in one transaction (spec 16)', async () => {
    await repo.create({
      id: 'keep',
      name: 'front_door',
      type: 'digital',
      config: { pin: 17 },
      debounceMs: 10_000,
      severity: 'info',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    await repo.create({
      id: 'drop',
      name: 'old_sensor',
      type: 'digital',
      config: { pin: 5 },
      debounceMs: 0,
      severity: 'info',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    const now = new Date('2030-05-01T00:00:00.000Z');
    await repo.applyImport({
      inserts: [
        {
          id: 'new',
          name: 'window_1',
          type: 'digital',
          config: { pin: 6 },
          debounceMs: 10_000,
          severity: 'info',
          createdAt: now,
        },
      ],
      updates: [
        { id: 'keep', patch: { config: { pin: 22 }, updatedAt: now } },
      ],
      archives: [{ id: 'drop', archivedAt: now }],
    });

    const active = ctx.db.select().from(sensors).all();
    expect(active.map((r) => r.name).sort()).toEqual(['front_door', 'window_1']);
    expect(active.find((r) => r.id === 'keep')?.config).toEqual({ pin: 22 });

    const archived = ctx.db.select().from(sensorsArchive).all();
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ id: 'drop', name: 'old_sensor', archivedAt: now });
  });
});
