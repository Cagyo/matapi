import { createHash } from 'node:crypto';
import type { DatabaseBackupDescriptor, DatabaseBackupSnapshotPort } from '../application/ports/database-backup-snapshot.port';

/** Deterministic in-memory parity adapter for archive application tests. */
export class InMemoryDatabaseBackupSnapshotAdapter implements DatabaseBackupSnapshotPort {
  private readonly snapshots = new Map<string, DatabaseBackupDescriptor>();

  async createOrLocateCompletedSnapshot(atMs: number): Promise<DatabaseBackupDescriptor> {
    const relativePath = `worker-${new Date(atMs).toISOString().replace(/:/gu, '')}.db`;
    const existing = this.snapshots.get(relativePath);
    if (existing) return existing;
    const sha256 = createHash('sha256').update(relativePath).digest('hex');
    const descriptor: DatabaseBackupDescriptor = {
      kind: 'database_backup', sourceIdentity: `database:${relativePath}`, trustedPath: `/in-memory-backups/${relativePath}`,
      relativePath, size: 0, mtimeNs: String(BigInt(atMs) * 1_000_000n), sourceTimeMs: atMs, sha256,
      sourceFingerprint: createHash('sha256').update([
        'database_backup', relativePath, '0', String(BigInt(atMs) * 1_000_000n), sha256,
      ].map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('\0')).digest('hex'),
    };
    this.snapshots.set(relativePath, descriptor);
    return descriptor;
  }

  async removeStaleTemporarySnapshots(): Promise<number> { return 0; }
  async listCompletedSnapshots(): Promise<readonly DatabaseBackupDescriptor[]> { return [...this.snapshots.values()]; }
  async pruneLocalSnapshots(input: { nowMs: number; pinnedPaths: ReadonlySet<string>; emergency: false }): Promise<readonly string[]> {
    const removed: string[] = [];
    for (const [key, snapshot] of this.snapshots) {
      if (snapshot.sourceTimeMs > input.nowMs - 7 * 24 * 60 * 60 * 1000 || input.pinnedPaths.has(snapshot.trustedPath)) continue;
      this.snapshots.delete(key);
      removed.push(snapshot.trustedPath);
    }
    return removed;
  }
}
