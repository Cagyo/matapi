import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TABLE = 'telegram_camera_source_prompts';
const ADMIN = 100;
const CHAT = 200;
const RECEIPT = '1234567890abcdef';
const EXPIRES_AT = Date.UTC(2030, 0, 1, 0, 10);

function migrationFilenames(): string[] {
  return readdirSync(resolve('migrations'))
    .filter((filename) => filename.endsWith('.sql'))
    .sort()
    .map((filename) => `migrations/${filename}`);
}

function executeMigrations(sqlite: Database.Database, filenames: string[]): void {
  for (const filename of filenames) {
    const sql = readFileSync(resolve(filename), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
}

/** The generated migration that introduces the exact-reply prompt table. */
function splitAtPromptMigration(): { before: string[]; from: string[] } {
  const migrations = migrationFilenames();
  const index = migrations.findIndex((filename) =>
    readFileSync(resolve(filename), 'utf8').includes(`CREATE TABLE \`${TABLE}\``),
  );
  if (index === -1) throw new Error('Generated camera source prompt migration was not found');
  return { before: migrations.slice(0, index), from: migrations.slice(index) };
}

describe('camera source prompt migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => sqlite.close());

  function seedAdministrator(userId = ADMIN): void {
    sqlite.prepare('INSERT INTO users (telegram_id, name, role) VALUES (?, ?, ?)')
      .run(userId, `admin-${userId}`, 'admin');
  }

  function insertPrompt(overrides: Record<string, string | number | null> = {}): void {
    const row: Record<string, string | number | null> = {
      user_id: ADMIN,
      chat_id: CHAT,
      receipt_id: RECEIPT,
      prompt_message_id: 90,
      reply_message_id: null,
      phase: 'credential',
      operation: 'create',
      camera_id: null,
      display_name: 'Front Door',
      expected_revision: null,
      status: 'pending',
      deletion_failed: 0,
      expires_at: EXPIRES_AT,
      retain_until: null,
      ...overrides,
    };
    const columns = Object.keys(row);
    sqlite
      .prepare(`INSERT INTO ${TABLE} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map((column) => row[column]));
  }

  it('introduces the prompt table without disturbing existing Telegram state', () => {
    const { before, from } = splitAtPromptMigration();
    executeMigrations(sqlite, before);
    expect(sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', TABLE))
      .toBeUndefined();
    seedAdministrator();
    sqlite.prepare(
      `INSERT INTO home_action_receipts
       (user_id, chat_id, kind, id, current_slot, session_token, status, payload, expires_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(ADMIN, CHAT, 'workflow-return', RECEIPT, 'token', 'pending', '{}', EXPIRES_AT, EXPIRES_AT);

    executeMigrations(sqlite, from);

    expect(sqlite.prepare('SELECT telegram_id AS userId, role FROM users').all())
      .toEqual([{ userId: ADMIN, role: 'admin' }]);
    expect(sqlite.prepare('SELECT id, status FROM home_action_receipts').all())
      .toEqual([{ id: RECEIPT, status: 'pending' }]);
    expect(sqlite.prepare(`SELECT count(*) AS total FROM ${TABLE}`).get()).toEqual({ total: 0 });
  });

  it('keys prompts by administrator, chat, receipt and prompt message', () => {
    executeMigrations(sqlite, migrationFilenames());
    seedAdministrator();

    insertPrompt({ prompt_message_id: 90 });
    insertPrompt({ prompt_message_id: 91 });
    insertPrompt({ receipt_id: 'fedcba0987654321' });
    insertPrompt({ chat_id: 201 });

    expect(sqlite.prepare(`SELECT count(*) AS total FROM ${TABLE}`).get()).toEqual({ total: 4 });
    expect(() => insertPrompt({ prompt_message_id: 90 })).toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  it('indexes the live and retention lookups the workflow depends on', () => {
    executeMigrations(sqlite, migrationFilenames());

    const indexes = sqlite
      .prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? ORDER BY name')
      .all('index', TABLE) as { name: string }[];

    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'idx_telegram_camera_source_prompts_live',
        'idx_telegram_camera_source_prompts_retention',
      ]),
    );
  });

  it('closes the phase, operation and status vocabularies at the table', () => {
    executeMigrations(sqlite, migrationFilenames());
    seedAdministrator();

    expect(() => insertPrompt({ phase: 'address' })).toThrow(/CHECK constraint failed/i);
    expect(() => insertPrompt({ operation: 'detach' })).toThrow(/CHECK constraint failed/i);
    expect(() => insertPrompt({ status: 'claimed' })).toThrow(/CHECK constraint failed/i);
  });

  it('refuses a group- or channel-shaped identity', () => {
    executeMigrations(sqlite, migrationFilenames());
    seedAdministrator();

    expect(() => insertPrompt({ chat_id: -1_001_234_567_890 })).toThrow(/CHECK constraint failed/i);
    expect(() => insertPrompt({ chat_id: 0 })).toThrow(/CHECK constraint failed/i);
    // The chat identifier is its own value; it need not equal the administrator.
    expect(() => insertPrompt()).not.toThrow();
  });

  it('retains a tombstone only for a terminal credential prompt', () => {
    executeMigrations(sqlite, migrationFilenames());
    seedAdministrator();

    expect(() => insertPrompt({ retain_until: EXPIRES_AT })).toThrow(/CHECK constraint failed/i);
    expect(() => insertPrompt({ status: 'consumed', retain_until: null })).toThrow(/CHECK constraint failed/i);
    expect(() => insertPrompt({
      phase: 'name', display_name: null, status: 'consumed', retain_until: EXPIRES_AT,
    })).toThrow(/CHECK constraint failed/i);
    expect(() => insertPrompt({ status: 'consumed', retain_until: EXPIRES_AT })).not.toThrow();
  });

  it('removes an administrator’s prompts with the account', () => {
    executeMigrations(sqlite, migrationFilenames());
    seedAdministrator();
    insertPrompt();

    sqlite.prepare('DELETE FROM users WHERE telegram_id = ?').run(ADMIN);

    expect(sqlite.prepare(`SELECT count(*) AS total FROM ${TABLE}`).get()).toEqual({ total: 0 });
  });
});
