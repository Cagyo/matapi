import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/database/schema';

describe('drive motion continuous sync migration', () => {
  const databases: Database.Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it('creates reservation and provider state with admission defaults', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: './migrations' });

    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      'drive_motion_folder_reservations', 'archive_provider_state',
    ]));
    const artifactColumns = sqlite.prepare('PRAGMA table_info(archive_artifacts)').all() as { name: string }[];
    expect(artifactColumns.map((row) => row.name)).toEqual(expect.arrayContaining([
      'admission_state', 'motion_day_path', 'admission_next_at', 'admission_error_code', 'admission_revision',
    ]));

    const reservationColumns = sqlite.prepare(
      'PRAGMA table_info(drive_motion_folder_reservations)',
    ).all() as { name: string }[];
    expect(reservationColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'revalidation_failure_streak', 'next_revalidation_at',
    ]));

    const schedulerColumns = sqlite.prepare(
      'PRAGMA table_info(archive_scheduler_state)',
    ).all() as { name: string }[];
    expect(schedulerColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'last_plausible_wall_time_ms', 'clock_health', 'observed_rollback_ms',
    ]));

    const indexes = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='index'",
    ).all() as { name: string }[];
    expect(indexes.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'idx_archive_artifacts_admission_queue',
      'idx_archive_artifacts_motion_day',
      'idx_archive_artifacts_registration_lookup',
      'idx_drive_attempts_generation_queue',
      'idx_drive_attempts_artifact_generation_state',
      'idx_drive_motion_folder_current_health',
    ]));
  });

  it('enforces a single current path reservation', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: './migrations' });

    const insertCurrent = sqlite.prepare("INSERT INTO drive_motion_folder_reservations (id, installation_id, generation_id, normalized_path, level, segment_name, folder_id, parent_folder_id, state, current_slot, revision, created_at, updated_at) VALUES (?, 'installation-1', 'generation-1', '2026/08', 'month', '08', ?, 'year-1', 'reserved', 1, 0, 1, 1)");
    insertCurrent.run('reservation-1', 'folder-1');
    expect(() => insertCurrent.run('reservation-2', 'folder-2')).toThrow();
  });

  it('enforces revalidation and clock-health bounds', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: './migrations' });

    expect(() => sqlite.prepare("INSERT INTO drive_motion_folder_reservations (id, installation_id, generation_id, normalized_path, level, segment_name, folder_id, parent_folder_id, state, revision, revalidation_failure_streak, created_at, updated_at) VALUES ('reservation-1', 'installation-1', 'generation-1', '2026', 'year', '2026', 'folder-1', 'root-1', 'reserved', 0, -1, 1, 1)").run()).toThrow();
    expect(() => sqlite.prepare("INSERT INTO archive_scheduler_state (id, revision, clock_health) VALUES (1, 0, 'malformed')").run()).toThrow();
    expect(() => sqlite.prepare("INSERT INTO archive_scheduler_state (id, revision, clock_health, observed_rollback_ms) VALUES (1, 0, 'clock-blocked', -1)").run()).toThrow();
  });
});
