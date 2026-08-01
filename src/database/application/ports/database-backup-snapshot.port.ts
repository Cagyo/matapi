/** Immutable, locally durable snapshot made from the live SQLite database. */
export interface DatabaseBackupDescriptor {
  readonly kind: 'database_backup';
  readonly sourceIdentity: string;
  readonly trustedPath: string;
  readonly relativePath: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly sourceTimeMs: number;
  readonly sha256: string;
  readonly sourceFingerprint: string;
}

export const DATABASE_BACKUP_SNAPSHOT = Symbol('DATABASE_BACKUP_SNAPSHOT');

/** Database-owned local backup lifecycle. Archive code receives descriptors only. */
export interface DatabaseBackupSnapshotPort {
  createOrLocateCompletedSnapshot(atMs: number): Promise<DatabaseBackupDescriptor>;
  removeStaleTemporarySnapshots(input: {
    nowMs: number;
    referencedPaths: ReadonlySet<string>;
  }): Promise<number>;
  listCompletedSnapshots(): Promise<readonly DatabaseBackupDescriptor[]>;
  pruneLocalSnapshots(input: {
    nowMs: number;
    pinnedPaths: ReadonlySet<string>;
    emergency: false;
  }): Promise<readonly string[]>;
}
