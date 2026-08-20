import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/database/schema';
import { DrizzleArchiveAdminAlertOutboxAdapter } from '../../../src/archive/infrastructure/events/drizzle-archive-admin-alert-outbox.adapter';

type TestDatabase = BetterSQLite3Database<typeof schema>;

const input = {
  fence: { id: 'generation-1', revision: 1, status: 'active' as const },
  kind: 'provider-capacity-blocked' as const,
  nowMs: 1_000,
  cooldownUntilMs: 3_601_000,
};

describe('DrizzleArchiveAdminAlertOutboxAdapter', () => {
  let sqlite: Database.Database;
  let db: TestDatabase;
  let outbox: DrizzleArchiveAdminAlertOutboxAdapter;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: './migrations' });
    outbox = new DrizzleArchiveAdminAlertOutboxAdapter(db, { maxUnsentEvents: 500 });
    db.insert(schema.driveConnections).values({
      id: 'generation-1', installationId: 'installation-1', status: 'active', revision: 1,
      clientIdHash: 'hash-1', currentSlot: 1, createdAt: 1, updatedAt: 1, alertCooldowns: {},
    }).run();
  });

  afterEach(() => sqlite.close());

  it('rolls back cooldown and event together when outbox insertion fails', async () => {
    sqlite.exec(`
      CREATE TRIGGER reject_archive_alert
      BEFORE INSERT ON events
      WHEN NEW.type = 'archive_admin_alert'
      BEGIN
        SELECT RAISE(FAIL, 'injected enqueue failure');
      END;
    `);

    await expect(outbox.enqueue(input)).rejects.toThrow('injected enqueue failure');
    expect(db.select({ cooldowns: schema.driveConnections.alertCooldowns })
      .from(schema.driveConnections).get()?.cooldowns).toEqual({});
    expect(db.select().from(schema.events).all()).toEqual([]);

    sqlite.exec('DROP TRIGGER reject_archive_alert');
    await expect(outbox.enqueue(input)).resolves.toMatchObject({
      payload: { kind: 'provider-capacity-blocked' },
    });
    await expect(outbox.enqueue(input)).resolves.toBeNull();
    expect(db.select().from(schema.events).all()).toHaveLength(1);
  });

  it('rejects a fenced alert after its generation is replaced before enqueue', async () => {
    db.transaction((tx) => {
      tx.update(schema.driveConnections).set({
        status: 'retiring', currentSlot: null, revision: 2, updatedAt: 2,
      }).where(eq(schema.driveConnections.id, 'generation-1')).run();
      tx.insert(schema.driveConnections).values({
        id: 'generation-2', installationId: 'installation-1', status: 'active', revision: 1,
        clientIdHash: 'hash-2', currentSlot: 1, createdAt: 2, updatedAt: 2, alertCooldowns: {},
      }).run();
    });

    await expect(outbox.enqueue(input)).resolves.toBeNull();
    expect(db.select({ cooldowns: schema.driveConnections.alertCooldowns })
      .from(schema.driveConnections)
      .where(eq(schema.driveConnections.id, 'generation-1'))
      .get()?.cooldowns).toEqual({});
    expect(db.select().from(schema.events).all()).toEqual([]);
  });
});
