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

function executeMigrations(sqlite: Database.Database, filenames: string[]): void {
  for (const filename of filenames) {
    const sql = readFileSync(resolve(filename), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
}

/** The generated migration that introduces the canonical camera name key. */
function splitAtNameKeyMigration(): { before: string[]; from: string[] } {
  const migrations = migrationFilenames();
  const index = migrations.findIndex((filename) =>
    readFileSync(resolve(filename), 'utf8').includes('name_key'),
  );
  if (index === -1) throw new Error('Generated camera name-key migration was not found');
  return { before: migrations.slice(0, index), from: migrations.slice(index) };
}

describe('rtsp camera source migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
  });

  afterEach(() => sqlite.close());

  function seedLegacyCameraWithSource(): void {
    sqlite
      .prepare('INSERT INTO cameras (id, name, type, config, enabled) VALUES (?, ?, ?, ?, ?)')
      .run('camera-1', 'Front Door', 'motion', '{"seeded":true}', 1);
    sqlite
      .prepare(
        `INSERT INTO camera_live_sources
         (camera_id, normalized_url, settings, ready, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('camera-1', 'rtsp://cam.local', '{"scheme":"rtsp"}', 1, 1_893_456_000, 1_893_456_100);
    sqlite
      .prepare(
        `INSERT INTO camera_live_credentials (camera_id, ciphertext, nonce, auth_tag, key_version)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('camera-1', 'cipher', 'nonce', 'tag', 1);
  }

  it('leaves existing cameras keyless for the one-time application backfill', () => {
    const { before, from } = splitAtNameKeyMigration();
    executeMigrations(sqlite, before);
    seedLegacyCameraWithSource();

    executeMigrations(sqlite, from);

    expect(sqlite.prepare('SELECT * FROM cameras').all()).toEqual([
      {
        id: 'camera-1',
        name: 'Front Door',
        type: 'motion',
        config: '{"seeded":true}',
        enabled: 1,
        name_key: null,
      },
    ]);
  });

  it('gives existing live sources revision 0 without losing source or credential data', () => {
    const { before, from } = splitAtNameKeyMigration();
    executeMigrations(sqlite, before);
    seedLegacyCameraWithSource();

    executeMigrations(sqlite, from);

    expect(sqlite.prepare('SELECT * FROM camera_live_sources').all()).toEqual([
      {
        camera_id: 'camera-1',
        normalized_url: 'rtsp://cam.local',
        settings: '{"scheme":"rtsp"}',
        ready: 1,
        created_at: 1_893_456_000,
        updated_at: 1_893_456_100,
        revision: 0,
        verified_at: null,
        policy_digest: null,
      },
    ]);
    expect(sqlite.prepare('SELECT camera_id, key_version FROM camera_live_credentials').all()).toEqual([
      { camera_id: 'camera-1', key_version: 1 },
    ]);
  });

  it('allows many keyless cameras but only one row per canonical key', () => {
    executeMigrations(sqlite, migrationFilenames());
    const insert = sqlite.prepare(
      'INSERT INTO cameras (id, name, type, config, enabled, name_key) VALUES (?, ?, ?, NULL, 1, ?)',
    );

    insert.run('camera-1', 'Front Door', 'motion', null);
    insert.run('camera-2', 'Back Door', 'motion', null);
    insert.run('camera-3', 'Garden', 'rtsp', 'garden');

    expect(() => insert.run('camera-4', 'GARDEN', 'rtsp', 'garden')).toThrow(/UNIQUE/);
  });
});
