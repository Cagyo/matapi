import Database from 'better-sqlite3';
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
});
