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

function executeMigration(sqlite: Database.Database, filename: string): void {
  const sql = readFileSync(resolve(filename), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

function executeMigrations(sqlite: Database.Database, filenames = migrationFilenames()): void {
  for (const filename of filenames) {
    executeMigration(sqlite, filename);
  }
}

describe('feature-management migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => sqlite.close());

  it('adds durable feature attention without rewriting existing feature rows', () => {
    const migrations = migrationFilenames();
    const featureManagementMigrationIndex = migrations.findIndex((filename) =>
      readFileSync(resolve(filename), 'utf8').includes('CREATE TABLE `feature_install_jobs`'),
    );
    if (featureManagementMigrationIndex === -1) {
      throw new Error('Generated feature-management migration was not found');
    }

    executeMigrations(sqlite, migrations.slice(0, featureManagementMigrationIndex));
    sqlite.prepare(
      'INSERT INTO features (name, enabled, installed, config) VALUES (?, ?, ?, ?)',
    ).run('motion', 1, 1, '{"source":"existing"}');
    executeMigrations(sqlite, migrations.slice(featureManagementMigrationIndex));

    expect(sqlite.prepare('SELECT attention_reason AS attentionReason FROM features WHERE name = ?')
      .get('motion')).toEqual({ attentionReason: null });
  });

  it('allows only one active install and releases the slot in both terminal states', () => {
    executeMigrations(sqlite);
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

  it('preserves existing install jobs when updating the active-slot CHECK constraint', () => {
    const migrations = migrationFilenames();
    const correctionMigrationIndex = migrations.findIndex((filename) =>
      readFileSync(resolve(filename), 'utf8').includes('CREATE TABLE `__new_feature_install_jobs`'),
    );
    if (correctionMigrationIndex === -1) {
      throw new Error('Generated active-slot correction migration was not found');
    }

    executeMigrations(sqlite, migrations.slice(0, correctionMigrationIndex));
    sqlite.prepare('INSERT INTO features (name, enabled, installed) VALUES (?, ?, ?)').run('digital', 0, 0);
    sqlite.prepare(`INSERT INTO feature_install_jobs
      (id, feature_name, status, active_slot, requested_by_user_id, requested_in_chat_id,
       workflow_receipt_id, previous_installed, previous_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('job0000000000001', 'digital', 'queued', 1, 1, 2, 'job-receipt', 0, 0, 1_893_456_000, 1_893_456_000);

    executeMigrations(sqlite, migrations.slice(correctionMigrationIndex));

    expect(sqlite.prepare('SELECT id, feature_name AS featureName, status, active_slot AS activeSlot, workflow_receipt_id AS workflowReceiptId FROM feature_install_jobs')
      .all()).toEqual([{
      id: 'job0000000000001',
      featureName: 'digital',
      status: 'queued',
      activeSlot: 1,
      workflowReceiptId: 'job-receipt',
    }]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects queued and running jobs that omit the active slot after the full migration chain', () => {
    executeMigrations(sqlite);
    sqlite.prepare('INSERT INTO features (name, enabled, installed) VALUES (?, ?, ?)').run('digital', 0, 0);
    sqlite.prepare('INSERT INTO features (name, enabled, installed) VALUES (?, ?, ?)').run('uart', 0, 0);
    const insertJob = (id: string, feature: string, status: string) => sqlite.prepare(
      `INSERT INTO feature_install_jobs
       (id, feature_name, status, active_slot, requested_by_user_id, requested_in_chat_id,
        workflow_receipt_id, previous_installed, previous_enabled, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, feature, status, 1, 2, `${id}-receipt`, 0, 0, 1_893_456_000, 1_893_456_000);

    expect(() => insertJob('job0000000000001', 'digital', 'queued')).toThrow(/CHECK/);
    expect(() => insertJob('job0000000000002', 'uart', 'running')).toThrow(/CHECK/);
  });

  it('preserves existing install jobs when adding the awaiting-restart phase', () => {
    const migrations = migrationFilenames();
    const awaitingRestartMigrationIndex = migrations.findIndex((filename) =>
      readFileSync(resolve(filename), 'utf8').includes('restart_dispatch_identity'),
    );
    if (awaitingRestartMigrationIndex === -1) {
      throw new Error('Generated awaiting-restart migration was not found');
    }

    executeMigrations(sqlite, migrations.slice(0, awaitingRestartMigrationIndex));
    sqlite.prepare('INSERT INTO features (name, enabled, installed) VALUES (?, ?, ?)').run('digital', 0, 0);
    sqlite.prepare(`INSERT INTO feature_install_jobs
      (id, feature_name, status, active_slot, requested_by_user_id, requested_in_chat_id,
       workflow_receipt_id, previous_installed, previous_enabled, restart_scope, failure_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('job0000000000001', 'digital', 'running', 1, 1, 2, 'job-receipt', 0, 0, null, null, 1_893_456_000, 1_893_456_000);
    sqlite.prepare(`INSERT INTO feature_install_jobs
      (id, feature_name, status, active_slot, requested_by_user_id, requested_in_chat_id,
       workflow_receipt_id, previous_installed, previous_enabled, restart_scope, failure_code, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('job0000000000002', 'digital', 'succeeded', 1, 2, 'old-receipt', 1, 1, 'worker', null, 1_893_455_000, 1_893_455_000);

    executeMigrations(sqlite, migrations.slice(awaitingRestartMigrationIndex));

    expect(sqlite.prepare(`SELECT id, status, active_slot AS activeSlot, operation,
        restart_dispatch_identity AS restartDispatchIdentity, restart_scope AS restartScope
      FROM feature_install_jobs ORDER BY id`).all()).toEqual([
      {
        id: 'job0000000000001',
        status: 'running',
        activeSlot: 1,
        operation: 'install',
        restartDispatchIdentity: null,
        restartScope: null,
      },
      {
        id: 'job0000000000002',
        status: 'succeeded',
        activeSlot: null,
        operation: 'install',
        restartDispatchIdentity: null,
        restartScope: 'worker',
      },
    ]);
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('holds the active slot for awaiting-restart jobs and still rejects unknown statuses', () => {
    executeMigrations(sqlite);
    sqlite.prepare('INSERT INTO features (name, enabled, installed) VALUES (?, ?, ?)').run('digital', 0, 0);
    const insertJob = (id: string, status: string, activeSlot: number | null) => sqlite.prepare(
      `INSERT INTO feature_install_jobs
       (id, feature_name, status, active_slot, operation, requested_by_user_id, requested_in_chat_id,
        workflow_receipt_id, previous_installed, previous_enabled, restart_dispatch_identity, created_at, updated_at)
       VALUES (?, 'digital', ?, ?, 'reinstall', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, status, activeSlot, 1, 2, `${id}-receipt`, 0, 0, 'boot-a:100', 1_893_456_000, 1_893_456_000);

    expect(() => insertJob('job0000000000001', 'awaiting-restart', 1)).not.toThrow();
    expect(() => insertJob('job0000000000002', 'awaiting-restart', 1)).toThrow(/UNIQUE/);
    expect(() => insertJob('job0000000000003', 'awaiting-restart', null)).toThrow(/CHECK/);
    expect(() => insertJob('job0000000000004', 'awaiting-reboot', null)).toThrow(/CHECK/);
    expect(sqlite.prepare('SELECT operation FROM feature_install_jobs WHERE id = ?')
      .get('job0000000000001')).toEqual({ operation: 'reinstall' });
  });
});
