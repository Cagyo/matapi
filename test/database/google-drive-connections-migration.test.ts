import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/database/schema';

describe('Google Drive connections migration', () => {
  const databases: Database.Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it('creates encrypted generation storage with one current and staged slot', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: './migrations' });

    const columns = sqlite.prepare('PRAGMA table_info(drive_connections)').all() as Array<{ name: string }>;
    const names = columns.map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining([
      'client_envelope', 'token_envelope', 'current_slot', 'staged_slot', 'revision', 'client_id_hash',
      'permission_id', 'root_folder_id', 'motion_folder_id', 'backups_folder_id', 'workflow_receipt_id', 'workflow_expires_at',
    ]));
    expect(names).not.toEqual(expect.arrayContaining(['client_secret', 'access_token', 'refresh_token']));

    sqlite.prepare("INSERT INTO drive_connections (id, installation_id, status, revision, client_id_hash, client_envelope, token_envelope, current_slot, permission_id, root_folder_id, motion_folder_id, backups_folder_id, created_at, updated_at, activated_at) VALUES (?, ?, 'active', 1, ?, ?, ?, 1, ?, ?, ?, ?, 1, 1, 1)")
      .run('generation-1', 'install-1', 'hash-1', '{"v":1}', '{"v":1}', 'permission-1', 'root-1', 'motion-1', 'backups-1');
    expect(() => sqlite.prepare("INSERT INTO drive_connections (id, installation_id, status, revision, client_id_hash, client_envelope, token_envelope, current_slot, permission_id, root_folder_id, motion_folder_id, backups_folder_id, created_at, updated_at, activated_at) VALUES (?, ?, 'active', 1, ?, ?, ?, 1, ?, ?, ?, ?, 1, 1, 1)")
      .run('generation-2', 'install-1', 'hash-2', '{"v":1}', '{"v":1}', 'permission-2', 'root-2', 'motion-2', 'backups-2')).toThrow();
  });
});
