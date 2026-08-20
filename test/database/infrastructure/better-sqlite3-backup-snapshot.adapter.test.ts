import { afterEach, describe, expect, it } from 'vitest';
import { BetterSqlite3BackupSnapshotAdapter, type BackupSnapshotFileSystem } from '../../../src/database/infrastructure/better-sqlite3-backup-snapshot.adapter';

const now = Date.parse('2026-07-29T12:00:00.000Z');
const root = '/var/lib/home-worker/backups';

describe('BetterSqlite3BackupSnapshotAdapter', () => {
  afterEach(() => {
    delete process.env.BACKUP_LOCAL_PATH;
  });

  it('publishes only after quick_check, file fsync, no-replace publish, and directory fsync', async () => {
    const files = new RecordingFiles();
    const adapter = new BetterSqlite3BackupSnapshotAdapter(
      { backup: async (path: string) => files.operations.push(`backup:${path.split('/').at(-1)}`) },
      {
        root,
        files,
        temporaryId: () => 'first',
        openSnapshot: () => ({ pragma: () => { files.operations.push('quick_check'); return [{ quick_check: 'ok' }]; }, close: () => undefined }),
      },
    );

    const snapshot = await adapter.createOrLocateCompletedSnapshot(now);

    expect(files.operations).toEqual([
      'mkdir',
      'reserve:worker-2026-07-29T120000.000Z.db-first.tmp',
      'backup:worker-2026-07-29T120000.000Z.db-first.tmp',
      'quick_check',
      'fsync:file',
      'publish:final',
      'fsync:directory',
      'remove:worker-2026-07-29T120000.000Z.db-first.tmp',
      'fsync:directory',
    ]);
    expect(snapshot.trustedPath.endsWith('.tmp')).toBe(false);
    expect(snapshot).toMatchObject({
      kind: 'database_backup',
      relativePath: 'worker-2026-07-29T120000.000Z.db',
      sourceTimeMs: now,
    });
  });

  it('retries a colliding exclusive temporary reservation instead of reusing it', async () => {
    const files = new RecordingFiles();
    files.reservationOutcomes = ['EEXIST', 'ok'];
    const ids = ['collision', 'fresh'];
    const adapter = new BetterSqlite3BackupSnapshotAdapter(
      { backup: async (path: string) => files.operations.push(`backup:${path.split('/').at(-1)}`) },
      {
        root,
        files,
        temporaryId: () => ids.shift() ?? 'unexpected',
        openSnapshot: () => ({ pragma: () => [{ quick_check: 'ok' }], close: () => undefined }),
      },
    );

    await adapter.createOrLocateCompletedSnapshot(now);

    expect(files.operations).toContain('reserve:worker-2026-07-29T120000.000Z.db-collision.tmp');
    expect(files.operations).toContain('reserve:worker-2026-07-29T120000.000Z.db-fresh.tmp');
    expect(files.operations).toContain('backup:worker-2026-07-29T120000.000Z.db-fresh.tmp');
    expect(files.operations).not.toContain('backup:worker-2026-07-29T120000.000Z.db-collision.tmp');
  });

  it('preserves a final snapshot concurrently published by another process', async () => {
    const files = new RecordingFiles();
    files.publishResult = false;
    const adapter = new BetterSqlite3BackupSnapshotAdapter(
      { backup: async (path: string) => files.operations.push(`backup:${path.split('/').at(-1)}`) },
      {
        root,
        files,
        temporaryId: () => 'ours',
        openSnapshot: () => ({ pragma: () => [{ quick_check: 'ok' }], close: () => undefined }),
      },
    );

    const snapshot = await adapter.createOrLocateCompletedSnapshot(now);

    expect(snapshot.trustedPath).toBe(`${root}/worker-2026-07-29T120000.000Z.db`);
    expect(files.operations).toContain('publish:final');
    expect(files.operations).toContain('remove:worker-2026-07-29T120000.000Z.db-ours.tmp');
    expect(files.operations).not.toContain('rename:final');
  });

  it('does not publish a backup that fails SQLite quick_check', async () => {
    const files = new RecordingFiles();
    const adapter = new BetterSqlite3BackupSnapshotAdapter(
      { backup: async (path: string) => files.operations.push(`backup:${path.split('/').at(-1)}`) },
      { root, files, openSnapshot: () => ({ pragma: () => [{ quick_check: 'corrupt' }], close: () => undefined }) },
    );

    await expect(adapter.createOrLocateCompletedSnapshot(now)).rejects.toThrow('quick_check');
    expect(files.operations.some((operation) => operation.startsWith('remove:worker-'))).toBe(true);
    expect(files.operations).not.toContain('publish:final');
  });

  it('removes only stale temporary snapshots under its staging root that are not live references', async () => {
    const files = new RecordingFiles();
    files.entries = [
      { name: 'worker-old.db.tmp', isFile: true, mtimeMs: now - 3_600_001 },
      { name: 'worker-old.db-550e8400-e29b-41d4-a716-446655440000.tmp', isFile: true, mtimeMs: now - 3_600_001 },
      { name: 'worker-live.db.tmp', isFile: true, mtimeMs: now - 3_600_001 },
      { name: 'outside.db.tmp', isFile: true, mtimeMs: now - 3_600_001 },
      { name: 'worker-link.db.tmp', isFile: false, mtimeMs: now - 3_600_001 },
    ];
    const adapter = new BetterSqlite3BackupSnapshotAdapter(
      { backup: async () => undefined },
      { root, files, openSnapshot: () => ({ pragma: () => [{ quick_check: 'ok' }], close: () => undefined }) },
    );

    await expect(adapter.removeStaleTemporarySnapshots({
      nowMs: now,
      referencedPaths: new Set([`${root}/worker-live.db.tmp`, '/other-root/outside.db.tmp']),
    })).resolves.toBe(2);

    expect(files.operations).toEqual([
      'remove:worker-old.db.tmp',
      'remove:worker-old.db-550e8400-e29b-41d4-a716-446655440000.tmp',
    ]);
  });

  it('never prunes a completed snapshot pinned by an unverified archive artifact', async () => {
    const files = new RecordingFiles();
    files.entries = [
      { name: 'worker-old.db', isFile: true, mtimeMs: now - 8 * 86_400_000 },
      { name: 'worker-new.db', isFile: true, mtimeMs: now - 86_400_000 },
    ];
    const adapter = new BetterSqlite3BackupSnapshotAdapter(
      { backup: async () => undefined },
      { root, files, openSnapshot: () => ({ pragma: () => [{ quick_check: 'ok' }], close: () => undefined }) },
    );

    await expect(adapter.pruneLocalSnapshots({
      nowMs: now,
      pinnedPaths: new Set([`${root}/worker-old.db`]),
      emergency: false,
    })).resolves.toEqual([]);
    expect(files.operations).toEqual([]);
  });
});

class RecordingFiles implements BackupSnapshotFileSystem {
  operations: string[] = [];
  entries: { name: string; isFile: boolean; mtimeMs: number }[] = [];
  reservationOutcomes: ('EEXIST' | 'ok')[] = [];
  publishResult = true;

  async ensureDirectory(): Promise<void> { this.operations.push('mkdir'); }
  async exists(): Promise<boolean> { return false; }
  async reserveTemporary(path: string): Promise<void> {
    this.operations.push(`reserve:${path.split('/').at(-1)}`);
    if (this.reservationOutcomes.shift() === 'EEXIST') {
      const error = Object.assign(new Error('exists'), { code: 'EEXIST' });
      throw error;
    }
  }
  async stat(): Promise<{ size: number; mtimeNs: bigint; mtimeMs: number }> { return { size: 42, mtimeNs: 123n, mtimeMs: now }; }
  async readDirectory(): Promise<readonly { name: string; isFile: boolean; mtimeMs: number }[]> { return this.entries; }
  async sha256(): Promise<string> { return 'a'.repeat(64); }
  async fsyncFile(): Promise<void> { this.operations.push('fsync:file'); }
  async publishNoReplace(): Promise<boolean> { this.operations.push('publish:final'); return this.publishResult; }
  async fsyncDirectory(): Promise<void> { this.operations.push('fsync:directory'); }
  async remove(path: string): Promise<void> { this.operations.push(`remove:${path.split('/').at(-1)}`); }
}
