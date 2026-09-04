import Database from 'better-sqlite3';
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
  for (const filename of migrationFilenames()) {
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

  function insertJob(
    id: string,
    status: string,
    activeSlot: number | null,
    failureCode: string | null,
    expectedGeneration = 3,
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
});
