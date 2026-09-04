import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function migrationFilenames(): string[] {
  return readdirSync(resolve('migrations'))
    .filter((filename) => filename.endsWith('.sql'))
    .sort()
    .map((filename) => `migrations/${filename}`);
}

function executeMigrations(sqlite: Database.Database): void {
  executeMigrationFiles(sqlite, migrationFilenames());
}

function executeMigrationFiles(sqlite: Database.Database, filenames: readonly string[]): void {
  for (const filename of filenames) {
    const sql = readFileSync(resolve(filename), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
}

describe('live-view-settings-job migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    executeMigrations(sqlite);
    sqlite.prepare("INSERT INTO users (telegram_id, name, role) VALUES (1001, 'Admin', 'admin')").run();
  });

  afterEach(() => sqlite.close());

  it('allows exactly one active settings job and releases the slot at terminalization', () => {
    insertJob('AbCdEfGhIjKlMnOp', 'prepared', 1, null);
    expect(() => insertJob('BcDeFgHiJkLmNoPq', 'published', 1, null)).toThrow(/UNIQUE/);

    sqlite.prepare(
      "UPDATE live_view_settings_jobs SET status = 'failed', active_slot = NULL, failure_code = 'interrupted' WHERE id = ?",
    ).run('AbCdEfGhIjKlMnOp');

    expect(() => insertJob('BcDeFgHiJkLmNoPq', 'committed', 1, null)).not.toThrow();
  });

  it.each([
    ['prepared', null, null],
    ['published', null, null],
    ['committed', null, null],
    ['restart-required', null, 'restart-dispatch-failed'],
    ['succeeded', 1, null],
    ['failed', 1, 'interrupted'],
  ] as const)(
    'rejects an inconsistent %s active slot or failure state',
    (status, activeSlot, failureCode) => {
      expect(() => insertJob('AbCdEfGhIjKlMnOp', status, activeSlot, failureCode))
        .toThrow(/CHECK/);
    },
  );

  it('rejects unknown statuses, failure codes, negative generations, and missing users', () => {
    expect(() => insertJob('AbCdEfGhIjKlMnOp', 'queued', 1, null)).toThrow(/CHECK/);
    expect(() => insertJob('AbCdEfGhIjKlMnOp', 'failed', null, 'exception-text')).toThrow(/CHECK/);
    expect(() => insertJob('AbCdEfGhIjKlMnOp', 'prepared', 1, null, -1)).toThrow(/CHECK/);
    expect(() => insertJob('AbCdEfGhIjKlMnOp', 'prepared', 1, null, 3, 9999)).toThrow(/FOREIGN KEY/);
  });

  it.each([
    'AbCdEfGhIjKlMnO',
    'AbCdEfGhIjKlMnOpQ',
    'AbCdEfGhIjKlMnO!',
  ])('rejects malformed request ID %s', (id) => {
    expect(() => insertJob(id, 'prepared', 1, null)).toThrow(/CHECK/);
  });

  it.each([
    ['fractional', 3.5],
    ['above the JavaScript safe-integer ceiling', 9_007_199_254_740_992n],
  ] as const)('rejects an expected generation that is %s', (_name, generation) => {
    expect(() => insertJob(
      'AbCdEfGhIjKlMnOp',
      'prepared',
      1,
      null,
      generation,
    )).toThrow(/CHECK/);
  });

  it('upgrades an authority that already applied the original generated 0022', () => {
    const upgrading = new Database(':memory:');
    try {
      upgrading.pragma('foreign_keys = ON');
      const filenames = migrationFilenames();
      const original0022 = filenames.findIndex((filename) => (
        filename.endsWith('/0022_loose_doctor_octopus.sql')
      ));
      expect(original0022).toBeGreaterThan(-1);

      executeMigrationFiles(upgrading, filenames.slice(0, original0022 + 1));
      upgrading.exec(`CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric
      )`);
      upgrading.prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
      ).run('applied-original-0022', 1_788_506_175_664);
      upgrading.prepare("INSERT INTO users (telegram_id, name, role) VALUES (1001, 'Admin', 'admin')").run();
      insertJobInto(upgrading, 'AbCdEfGhIjKlMnOp', 'succeeded', null, null, 3);

      expect(() => migrate(drizzle(upgrading), { migrationsFolder: 'migrations' }))
        .not.toThrow();
      const applied = upgrading.prepare(
        'SELECT created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at',
      ).all() as { createdAt: number }[];
      expect(applied[0]).toEqual({ createdAt: 1_788_506_175_664 });
      expect(applied.some(({ createdAt }) => createdAt > 1_788_506_175_664)).toBe(true);
      expect(upgrading.prepare(
        'SELECT id, expected_generation AS expectedGeneration FROM live_view_settings_jobs',
      ).all()).toEqual([{ id: 'AbCdEfGhIjKlMnOp', expectedGeneration: 3 }]);
      expect(() => insertJobInto(upgrading, 'malformed', 'succeeded', null, null, 3))
        .toThrow(/CHECK/);
      expect(() => insertJobInto(
        upgrading,
        'BcDeFgHiJkLmNoPq',
        'succeeded',
        null,
        null,
        3.5,
      )).toThrow(/CHECK/);
    } finally {
      upgrading.close();
    }
  });

  function insertJob(
    id: string,
    status: string,
    activeSlot: number | null,
    failureCode: string | null,
    expectedGeneration: number | bigint = 3,
    requestedByUserId = 1001,
  ): void {
    insertJobInto(
      sqlite,
      id,
      status,
      activeSlot,
      failureCode,
      expectedGeneration,
      requestedByUserId,
    );
  }
});

function insertJobInto(
  sqlite: Database.Database,
  id: string,
  status: string,
  activeSlot: number | null,
  failureCode: string | null,
  expectedGeneration: number | bigint,
  requestedByUserId = 1001,
): void {
  sqlite.prepare(`INSERT INTO live_view_settings_jobs
      (id, status, active_slot, expected_generation, candidate_settings,
       requested_by_user_id, requested_in_chat_id, workflow_receipt_id,
       failure_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      status,
      activeSlot,
      expectedGeneration,
      '{"enabled":true,"allowedCameraCidrs":["192.168.1.0/24"]}',
      requestedByUserId,
      1001,
      'QrStUvWxYz012345',
      failureCode,
      1_893_456_000,
      1_893_456_000,
    );
}
