import { afterEach, describe, expect, it } from 'vitest';
import { BetterSqlite3BackupSnapshotAdapter, type BackupSnapshotFileSystem } from '../../../src/database/infrastructure/better-sqlite3-backup-snapshot.adapter';

const now = Date.parse('2026-07-29T12:00:00.000Z');
const root = '/var/lib/home-worker/backups';

describe('BetterSqlite3BackupSnapshotAdapter', () => {
  afterEach(() => {
    delete process.env.BACKUP_LOCAL_PATH;
  });

  it('publishes only after quick_check, file fsync, rename, and directory fsync', async () => {
    const files = new RecordingFiles();
    const adapter = new BetterSqlite3BackupSnapshotAdapter(
      { backup: async (path: string) => files.operations.push(`backup:${path.split('/').at(-1)}`) },
      { root, files, openSnapshot: () => ({ pragma: () => { files.operations.push('quick_check'); return [{ quick_check: 'ok' }]; }, close: () => undefined }) },
    );

    const snapshot = await adapter.createOrLocateCompletedSnapshot(now);

    expect(files.operations).toEqual([
      'mkdir',
      'backup:worker-2026-07-29T120000.000Z.db.tmp',
      'quick_check',
      'fsync:file',
      'rename:final',
      'fsync:directory',
    ]);
    expect(snapshot.trustedPath.endsWith('.tmp')).toBe(false);
    expect(snapshot).toMatchObject({
      kind: 'database_backup',
      relativePath: 'worker-2026-07-29T120000.000Z.db',
      sourceTimeMs: now,
    });
  });

  it('does not publish a backup that fails SQLite quick_check', async () => {
    const files = new RecordingFiles();
    const adapter = new BetterSqlite3BackupSnapshotAdapter(
      { backup: async (path: string) => files.operations.push(`backup:${path.split('/').at(-1)}`) },
      { root, files, openSnapshot: () => ({ pragma: () => [{ quick_check: 'corrupt' }], close: () => undefined }) },
    );

    await expect(adapter.createOrLocateCompletedSnapshot(now)).rejects.toThrow('quick_check');
    expect(files.operations).toContain('remove:tmp');
    expect(files.operations).not.toContain('rename:final');
  });

  it('removes only stale temporary snapshots under its staging root that are not live references', async () => {
    const files = new RecordingFiles();
    files.entries = [
      { name: 'worker-old.db.tmp', isFile: true, mtimeMs: now - 3_600_001 },
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
    })).resolves.toBe(1);

    expect(files.operations).toEqual(['remove:worker-old.db.tmp']);
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
  entries: Array<{ name: string; isFile: boolean; mtimeMs: number }> = [];

  async ensureDirectory(): Promise<void> { this.operations.push('mkdir'); }
  async exists(): Promise<boolean> { return false; }
  async stat(): Promise<{ size: number; mtimeNs: bigint; mtimeMs: number }> { return { size: 42, mtimeNs: 123n, mtimeMs: now }; }
  async readDirectory(): Promise<readonly { name: string; isFile: boolean; mtimeMs: number }[]> { return this.entries; }
  async sha256(): Promise<string> { return 'a'.repeat(64); }
  async fsyncFile(): Promise<void> { this.operations.push('fsync:file'); }
  async rename(): Promise<void> { this.operations.push('rename:final'); }
  async fsyncDirectory(): Promise<void> { this.operations.push('fsync:directory'); }
  async remove(path: string): Promise<void> { this.operations.push(`remove:${path.split('/').at(-1)?.replace('worker-2026-07-29T120000.000Z.db.tmp', 'tmp')}`); }
}
