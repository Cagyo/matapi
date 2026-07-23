import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function migrations(): string[] {
  return readdirSync(resolve('migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => `migrations/${name}`);
}

function run(sqlite: Database.Database, files: readonly string[]): void {
  for (const file of files) {
    for (const statement of readFileSync(resolve(file), 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
}

describe('home-action receipt history migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => sqlite.close());

  it('preserves a legacy current receipt and permits one historical row beside its replacement', () => {
    const files = migrations();
    const historyIndex = files.findIndex((file) => file.includes('0008_'));
    if (historyIndex === -1) throw new Error('Generated receipt-history migration was not found');
    run(sqlite, files.slice(0, historyIndex));
    sqlite.prepare('INSERT INTO users (telegram_id, name, role, locale) VALUES (1, ?, ?, ?)')
      .run('Admin', 'admin', 'en');
    sqlite.prepare(`INSERT INTO home_action_receipts
      (user_id, chat_id, kind, id, session_token, status, payload, expires_at, updated_at)
      VALUES (1, 2, 'workflow-return', 'abcdefghijklmnop', NULL, 'executing', '{}', 1, 1)`)
      .run();

    run(sqlite, files.slice(historyIndex));
    expect(sqlite.prepare(`SELECT current_slot AS currentSlot FROM home_action_receipts
      WHERE id = 'abcdefghijklmnop'`).get()).toEqual({ currentSlot: 1 });
    sqlite.prepare(`UPDATE home_action_receipts SET current_slot = NULL
      WHERE id = 'abcdefghijklmnop'`).run();
    expect(() => sqlite.prepare(`INSERT INTO home_action_receipts
      (user_id, chat_id, kind, id, current_slot, session_token, status, payload, expires_at, updated_at)
      VALUES (1, 2, 'workflow-return', 'ponmlkjihgfedcba', 1, NULL, 'pending', '{}', 2, 2)`).run())
      .not.toThrow();
    expect(sqlite.prepare("SELECT count(*) AS count FROM home_action_receipts WHERE kind = 'workflow-return'").get())
      .toEqual({ count: 2 });
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
