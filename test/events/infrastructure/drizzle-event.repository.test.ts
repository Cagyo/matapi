import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import { events } from '../../../src/database/schema';
import { DrizzleEventRepository } from '../../../src/events/infrastructure/drizzle-event.repository';

type TestDatabase = BetterSQLite3Database<typeof schema>;

const options = {
  batchSize: 50,
  maxQueueBeforeForceAggregate: 1,
  maxUnsentEvents: 500,
};

async function enqueue(
  repository: DrizzleEventRepository,
  sensorId: string,
  timestamp: string,
) {
  return repository.enqueue({
    sensorId,
    type: 'state_change',
    payload: { newValue: true },
    createdAt: new Date(timestamp),
  });
}

describe('DrizzleEventRepository', () => {
  let sqlite: Database.Database;
  let db: TestDatabase;
  let repository: DrizzleEventRepository;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    repository = new DrizzleEventRepository(db, options);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('stores pending events and marks them sent at the provided timestamp', async () => {
    const createdAt = new Date('2029-12-31T23:59:00.000Z');
    const sentAt = new Date('2030-01-01T00:00:00.000Z');
    const queued = await repository.enqueue({
      sensorId: 'front_door',
      type: 'state_change',
      payload: { oldValue: false, newValue: true },
      createdAt,
    });

    expect(queued).toMatchObject({
      id: 1,
      sensorId: 'front_door',
      type: 'state_change',
      payload: { oldValue: false, newValue: true },
      createdAt,
    });
    expect((await repository.pending()).map((event) => event.id)).toEqual([queued.id]);

    await repository.markSent([queued.id], sentAt);

    expect(await repository.pending()).toEqual([]);

    const [row] = db.select().from(events).where(eq(events.id, queued.id)).all();
    expect(row.sentAt?.toISOString()).toBe(sentAt.toISOString());
  });

  it('returns oldest unsent events up to the requested limit', async () => {
    await repository.enqueue({
      sensorId: 'newer',
      type: 'state_change',
      payload: null,
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const older = await repository.enqueue({
      sensorId: 'older',
      type: 'state_change',
      payload: null,
      createdAt: new Date('2029-12-31T23:59:00.000Z'),
    });

    expect(await repository.pending(1)).toEqual([older]);
  });

  it('normalizes scalar payloads read from the database', async () => {
    db.insert(events)
      .values({
        sensorId: null,
        type: 'system',
        payload: 'raw-value',
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
      })
      .run();

    expect(await repository.pending()).toMatchObject([
      {
        sensorId: null,
        type: 'system',
        payload: { value: 'raw-value' },
      },
    ]);
  });

  it('ignores empty mark-sent batches', async () => {
    const queued = await repository.enqueue({
      sensorId: 'front_door',
      type: 'state_change',
      payload: null,
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    await repository.markSent([], new Date('2030-01-01T00:01:00.000Z'));

    expect((await repository.pending()).map((event) => event.id)).toEqual([queued.id]);
  });

  it('does not evict sent rows when bounding unsent events', async () => {
    repository = new DrizzleEventRepository(db, { ...options, maxUnsentEvents: 1 });
    const sent = await enqueue(repository, 'sent', '2030-01-01T00:00:00.000Z');
    await repository.markSent([sent.id], new Date('2030-01-01T00:00:01.000Z'));
    const pending = await enqueue(repository, 'pending', '2030-01-01T00:00:02.000Z');

    expect(await repository.pending()).toEqual([pending]);
    const [storedSent] = db.select().from(events).where(eq(events.id, sent.id)).all();
    expect(storedSent.sentAt).not.toBeNull();
  });

  it('atomically bounds concurrent enqueue calls', async () => {
    repository = new DrizzleEventRepository(db, { ...options, maxUnsentEvents: 2 });

    await Promise.all([
      enqueue(repository, 'first', '2030-01-01T00:00:00.000Z'),
      enqueue(repository, 'second', '2030-01-01T00:01:00.000Z'),
      enqueue(repository, 'third', '2030-01-01T00:02:00.000Z'),
    ]);

    expect(await repository.countPending()).toBe(2);
  });
});
