import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/database/schema';

describe('motion archive reference migration', () => {
  const databases: Database.Database[] = [];
  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it('replaces legacy Drive flags with a nullable archive artifact reference', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: './migrations' });

    const columns = sqlite.prepare('PRAGMA table_info(motion_events)').all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toContain('archive_artifact_id');
    expect(columns.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
      'uploaded_to_gdrive', 'gdrive_file_id',
    ]));
  });

  it('drops populated legacy values instead of treating them as verified archive state', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    sqlite.exec(`
      CREATE TABLE archive_artifacts (id text PRIMARY KEY);
      CREATE TABLE motion_events (
        id integer PRIMARY KEY,
        camera_id text,
        started_at integer,
        ended_at integer,
        video_path text,
        snapshot_path text,
        uploaded_to_gdrive integer,
        gdrive_file_id text,
        local_deleted integer
      );
      CREATE INDEX idx_motion_not_uploaded ON motion_events (uploaded_to_gdrive);
      INSERT INTO motion_events VALUES (1, NULL, 1, 2, '/motion/a.mp4', NULL, 1, 'legacy-remote-id', 0);
    `);

    const sql = readFileSync('migrations/0016_perpetual_pepper_potts.sql', 'utf8')
      .replaceAll('--> statement-breakpoint', '');
    sqlite.exec(sql);

    const row = sqlite.prepare('SELECT archive_artifact_id FROM motion_events WHERE id = 1').get() as { archive_artifact_id: string | null };
    expect(row.archive_artifact_id).toBeNull();
    const columns = sqlite.prepare('PRAGMA table_info(motion_events)').all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
      'uploaded_to_gdrive', 'gdrive_file_id',
    ]));
  });
});
