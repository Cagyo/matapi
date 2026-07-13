import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import {
  cameraLiveCredentials,
  cameraLiveSources,
} from '../../../src/database/schema';

describe('live source schema contract', () => {
  it('defines one metadata row per camera with cascade deletion', () => {
    const config = getTableConfig(cameraLiveSources);
    const cameraId = config.columns.find((column) => column.name === 'camera_id');

    expect(config.name).toBe('camera_live_sources');
    expect(config.columns.map((column) => column.name)).toEqual([
      'camera_id',
      'normalized_url',
      'settings',
      'ready',
      'created_at',
      'updated_at',
    ]);
    expect(cameraId).toMatchObject({ primary: true, notNull: true });
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.onDelete).toBe('cascade');
    expect(
      getTableConfig(config.foreignKeys[0].reference().foreignTable).name,
    ).toBe('cameras');
  });

  it('defines exactly one ciphertext-only credential row per source', () => {
    const config = getTableConfig(cameraLiveCredentials);
    const cameraId = config.columns.find((column) => column.name === 'camera_id');

    expect(config.name).toBe('camera_live_credentials');
    expect(config.columns.map((column) => column.name)).toEqual([
      'camera_id',
      'ciphertext',
      'nonce',
      'auth_tag',
      'key_version',
    ]);
    expect(cameraId).toMatchObject({ primary: true, notNull: true });
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.onDelete).toBe('cascade');
    expect(
      getTableConfig(config.foreignKeys[0].reference().foreignTable).name,
    ).toBe('camera_live_sources');
    expect(config.columns.every((column) => column.notNull)).toBe(true);
  });

  it('applies one-to-one constraints and cascades through the generated migration', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: './migrations' });

    try {
      sqlite
        .prepare(
          'INSERT INTO cameras (id, name, type) VALUES (?, ?, ?)',
        )
        .run('front_door', 'Front door', 'rtsp');
      const insertSource = sqlite.prepare(
        `INSERT INTO camera_live_sources
          (camera_id, normalized_url, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insertSource.run(
        'front_door',
        'rtsp://cam.local',
        '{}',
        1_800_000_000,
        1_800_000_000,
      );
      expect(() =>
        insertSource.run(
          'front_door',
          'rtsp://other.local',
          '{}',
          1_800_000_001,
          1_800_000_001,
        ),
      ).toThrow();

      const insertCredential = sqlite.prepare(
        `INSERT INTO camera_live_credentials
          (camera_id, ciphertext, nonce, auth_tag, key_version)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insertCredential.run('front_door', 'cipher', 'nonce', 'tag', 1);
      expect(() =>
        insertCredential.run('front_door', 'other', 'nonce', 'tag', 1),
      ).toThrow();

      sqlite.prepare('DELETE FROM cameras WHERE id = ?').run('front_door');
      expect(
        sqlite.prepare('SELECT count(*) AS count FROM camera_live_sources').get(),
      ).toEqual({ count: 0 });
      expect(
        sqlite
          .prepare('SELECT count(*) AS count FROM camera_live_credentials')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });
});
