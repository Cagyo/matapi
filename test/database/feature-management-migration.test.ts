import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function featureManagementMigration(): string {
  const filename = readdirSync(resolve('migrations')).find((entry) => {
    if (!entry.endsWith('.sql')) return false;
    return readFileSync(resolve('migrations', entry), 'utf8').includes('feature_install_jobs');
  });
  if (!filename) throw new Error('Generated feature-management migration was not found');
  return `migrations/${filename}`;
}

function executeMigration(sqlite: Database.Database, filename: string): void {
  const sql = readFileSync(resolve(filename), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

describe('feature-management migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    for (const filename of readdirSync(resolve('migrations')).sort()) {
      if (filename.endsWith('.sql') && !readFileSync(resolve('migrations', filename), 'utf8').includes('feature_install_jobs')) {
        executeMigration(sqlite, `migrations/${filename}`);
      }
    }
    executeMigration(sqlite, featureManagementMigration());
  });

  afterEach(() => sqlite.close());

  it('adds durable feature attention without rewriting existing feature rows', () => {
    sqlite.prepare(
      'INSERT INTO features (name, enabled, installed, config) VALUES (?, ?, ?, ?)',
    ).run('motion', 1, 1, '{"source":"existing"}');

    expect(sqlite.prepare('SELECT attention_reason AS attentionReason FROM features WHERE name = ?')
      .get('motion')).toEqual({ attentionReason: null });
  });

  it('allows only one active install and releases the slot in both terminal states', () => {
    sqlite.prepare('INSERT INTO features (name, enabled, installed) VALUES (?, ?, ?)').run('digital', 0, 0);
    sqlite.prepare('INSERT INTO features (name, enabled, installed) VALUES (?, ?, ?)').run('uart', 0, 0);
    const insertJob = (id: string, feature: string, activeSlot: number | null, status: string) => sqlite.prepare(
      `INSERT INTO feature_install_jobs
       (id, feature_name, status, active_slot, requested_by_user_id, requested_in_chat_id,
        workflow_receipt_id, previous_installed, previous_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, feature, status, activeSlot, 1, 2, `${id}-receipt`, 0, 0, 1_893_456_000, 1_893_456_000);

    insertJob('job0000000000001', 'digital', 1, 'queued');
    expect(() => insertJob('job0000000000002', 'uart', 1, 'queued')).toThrow(/UNIQUE/);
    sqlite.prepare("UPDATE feature_install_jobs SET status = 'failed', active_slot = NULL WHERE id = ?")
      .run('job0000000000001');
    expect(() => insertJob('job0000000000002', 'uart', 1, 'queued')).not.toThrow();
    sqlite.prepare("UPDATE feature_install_jobs SET status = 'succeeded', active_slot = NULL WHERE id = ?")
      .run('job0000000000002');
    expect(() => insertJob('job0000000000003', 'digital', 1, 'queued')).not.toThrow();
  });
});
