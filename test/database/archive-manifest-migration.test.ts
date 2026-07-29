import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/database/schema';

describe('archive manifest migration', () => {
  const databases: Database.Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it('creates durable artifact, append-only attempt, and scheduler tables', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: './migrations' });

    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'archive_artifacts', 'drive_object_attempts', 'archive_scheduler_state',
    ]));

    const attemptColumns = sqlite.prepare('PRAGMA table_info(drive_object_attempts)').all() as Array<{ name: string }>;
    expect(attemptColumns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'remote_file_id', 'lease_owner', 'lease_expires_at', 'session_ciphertext',
      'session_nonce', 'session_auth_tag', 'confirmed_offset', 'verified_sha256',
      'verified_sharing', 'next_attempt_at', 'revision',
    ]));
  });

  it('enforces immutable source and remote identifiers and complete verified rows', () => {
    const sqlite = new Database(':memory:');
    databases.push(sqlite);
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: './migrations' });

    const insertArtifact = sqlite.prepare("INSERT INTO archive_artifacts (id, installation_id, kind, source_identity, trusted_path, relative_path, size, mtime_ns, source_time_ms, sha256, source_fingerprint, state, created_at, updated_at, revision) VALUES (?, 'installation-1', 'motion_video', 'camera-1', '/trusted/clip.mp4', 'motion/clip.mp4', 42, '100', 100, ?, ?, 'pending', 100, 100, 0)");
    insertArtifact.run('artifact-1', 'a'.repeat(64), 'b'.repeat(64));
    expect(() => insertArtifact.run('artifact-2', 'c'.repeat(64), 'b'.repeat(64))).toThrow();

    const insertAttempt = sqlite.prepare("INSERT INTO drive_object_attempts (id, artifact_id, generation_id, remote_file_id, parent_id, reserved_at, state, revision, next_attempt_at, created_at, updated_at) VALUES (?, 'artifact-1', 'generation-1', ?, 'folder-1', 100, ?, 0, 100, 100, 100)");
    insertAttempt.run('attempt-1', 'file-1', 'pending');
    expect(() => insertAttempt.run('attempt-2', 'file-1', 'pending')).toThrow();
    expect(() => insertAttempt.run('attempt-3', 'file-2', 'verified')).toThrow();
  });
});
