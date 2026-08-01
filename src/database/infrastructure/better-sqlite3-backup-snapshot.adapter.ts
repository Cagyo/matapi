import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import type { DatabaseBackupDescriptor, DatabaseBackupSnapshotPort } from '../application/ports/database-backup-snapshot.port';

const STALE_TEMPORARY_MS = 60 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const COMPLETED_NAME = /^worker-(.+)\.db$/u;
const TEMPORARY_NAME = /^worker-.+\.db(?:\.\d+)?\.tmp$/u;

export interface BackupSnapshotFileSystem {
  ensureDirectory(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number; mtimeNs: bigint; mtimeMs: number }>;
  readDirectory(root: string): Promise<readonly { name: string; isFile: boolean; mtimeMs: number }[]>;
  sha256(path: string): Promise<string>;
  fsyncFile(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface BetterSqlite3BackupSnapshotOptions {
  root?: string;
  files?: BackupSnapshotFileSystem;
  openSnapshot?: (path: string) => Pick<Database.Database, 'pragma' | 'close'>;
  staleTemporaryMs?: number;
  retentionMs?: number;
}

/**
 * Uses SQLite's online backup API then publishes one immutable file with the
 * POSIX durability sequence: validate, fsync file, atomic rename, fsync dir.
 */
export class BetterSqlite3BackupSnapshotAdapter implements DatabaseBackupSnapshotPort {
  private readonly root: string;
  private readonly files: BackupSnapshotFileSystem;
  private readonly openSnapshot: (path: string) => Pick<Database.Database, 'pragma' | 'close'>;
  private readonly staleTemporaryMs: number;
  private readonly retentionMs: number;
  private readonly inFlight = new Map<number, Promise<DatabaseBackupDescriptor>>();

  constructor(
    private readonly sqlite: Pick<Database.Database, 'backup'>,
    options: BetterSqlite3BackupSnapshotOptions = {},
  ) {
    this.root = resolve(options.root ?? dirname(resolve(process.env.BACKUP_LOCAL_PATH ?? './data/backup.db')));
    this.files = options.files ?? new NodeBackupSnapshotFileSystem();
    this.openSnapshot = options.openSnapshot ?? ((path) => new Database(path, { readonly: true, fileMustExist: true }));
    this.staleTemporaryMs = options.staleTemporaryMs ?? STALE_TEMPORARY_MS;
    this.retentionMs = options.retentionMs ?? RETENTION_MS;
  }

  createOrLocateCompletedSnapshot(atMs: number): Promise<DatabaseBackupDescriptor> {
    const existing = this.inFlight.get(atMs);
    if (existing) return existing;
    const creating = this.create(atMs).finally(() => this.inFlight.delete(atMs));
    this.inFlight.set(atMs, creating);
    return creating;
  }

  async removeStaleTemporarySnapshots(input: { nowMs: number; referencedPaths: ReadonlySet<string> }): Promise<number> {
    const referenced = new Set([...input.referencedPaths].map((path) => resolve(path)));
    let removed = 0;
    for (const entry of await this.files.readDirectory(this.root)) {
      if (!entry.isFile || !TEMPORARY_NAME.test(entry.name) || entry.mtimeMs > input.nowMs - this.staleTemporaryMs) continue;
      const candidate = this.child(entry.name);
      if (referenced.has(candidate)) continue;
      await this.files.remove(candidate);
      removed += 1;
    }
    return removed;
  }

  async listCompletedSnapshots(): Promise<readonly DatabaseBackupDescriptor[]> {
    const entries = await this.files.readDirectory(this.root);
    const descriptors: DatabaseBackupDescriptor[] = [];
    for (const entry of entries) {
      if (!entry.isFile || !COMPLETED_NAME.test(entry.name)) continue;
      descriptors.push(await this.describe(this.child(entry.name), timestampFromName(entry.name, entry.mtimeMs)));
    }
    return descriptors.sort((left, right) => left.sourceTimeMs - right.sourceTimeMs || left.trustedPath.localeCompare(right.trustedPath));
  }

  async pruneLocalSnapshots(input: { nowMs: number; pinnedPaths: ReadonlySet<string>; emergency: false }): Promise<readonly string[]> {
    const pinned = new Set([...input.pinnedPaths].map((path) => resolve(path)));
    const removed: string[] = [];
    for (const entry of await this.files.readDirectory(this.root)) {
      if (!entry.isFile || !COMPLETED_NAME.test(entry.name) || entry.mtimeMs > input.nowMs - this.retentionMs) continue;
      const candidate = this.child(entry.name);
      if (pinned.has(candidate)) continue;
      await this.files.remove(candidate);
      removed.push(candidate);
    }
    return removed;
  }

  private async create(atMs: number): Promise<DatabaseBackupDescriptor> {
    if (!Number.isSafeInteger(atMs) || atMs < 0) throw new Error('Backup source time must be a non-negative integer');
    await this.files.ensureDirectory(this.root);
    const finalPath = this.child(`worker-${timestamp(atMs)}.db`);
    if (await this.files.exists(finalPath)) return this.describe(finalPath, atMs);
    const temporaryPath = await this.nextTemporaryPath(finalPath);
    try {
      await this.sqlite.backup(temporaryPath);
      this.assertQuickCheck(temporaryPath);
      await this.files.fsyncFile(temporaryPath);
      // A second worker may have published this exact timestamp while this
      // process was creating its private staging file. Keep that immutable one.
      if (await this.files.exists(finalPath)) {
        await this.files.remove(temporaryPath);
        return this.describe(finalPath, atMs);
      }
      await this.files.rename(temporaryPath, finalPath);
      await this.files.fsyncDirectory(this.root);
      return this.describe(finalPath, atMs);
    } catch (error) {
      await this.files.remove(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private assertQuickCheck(path: string): void {
    const snapshot = this.openSnapshot(path);
    try {
      const rows = snapshot.pragma('quick_check') as readonly { quick_check?: unknown }[];
      if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
        throw new Error('SQLite backup quick_check did not return ok');
      }
    } finally {
      snapshot.close();
    }
  }

  private async nextTemporaryPath(finalPath: string): Promise<string> {
    const first = `${finalPath}.tmp`;
    if (!(await this.files.exists(first))) return first;
    for (let suffix = 1; ; suffix += 1) {
      const candidate = `${finalPath}.${suffix}.tmp`;
      if (!(await this.files.exists(candidate))) return candidate;
    }
  }

  private async describe(path: string, sourceTimeMs: number): Promise<DatabaseBackupDescriptor> {
    const metadata = await this.files.stat(path);
    const relativePath = basename(path);
    const sha256 = await this.files.sha256(path);
    return {
      kind: 'database_backup',
      sourceIdentity: `database:${relativePath}`,
      trustedPath: path,
      relativePath,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs.toString(),
      sourceTimeMs,
      sha256,
      sourceFingerprint: digest(snapshotFingerprintInput(relativePath, metadata.size, metadata.mtimeNs.toString(), sha256)),
    };
  }

  private child(name: string): string {
    const candidate = resolve(this.root, name);
    if (!candidate.startsWith(`${this.root}${sep}`) || dirname(candidate) !== this.root) {
      throw new Error('Backup snapshot path escaped its staging root');
    }
    return candidate;
  }
}

class NodeBackupSnapshotFileSystem implements BackupSnapshotFileSystem {
  async ensureDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true }); }
  async exists(path: string): Promise<boolean> { return stat(path).then(() => true).catch(() => false); }
  async stat(path: string): Promise<{ size: number; mtimeNs: bigint; mtimeMs: number }> {
    const value = await stat(path, { bigint: true });
    return { size: Number(value.size), mtimeNs: value.mtimeNs, mtimeMs: Number(value.mtimeMs) };
  }
  async readDirectory(root: string): Promise<readonly { name: string; isFile: boolean; mtimeMs: number }[]> {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      return Promise.all(entries.map(async (entry) => {
        const value = await stat(resolve(root, entry.name), { bigint: true }).catch(() => null);
        return { name: entry.name, isFile: entry.isFile(), mtimeMs: value ? Number(value.mtimeMs) : Number.POSITIVE_INFINITY };
      }));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async sha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
  }
  async fsyncFile(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  async rename(from: string, to: string): Promise<void> { await rename(from, to); }
  async fsyncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  async remove(path: string): Promise<void> { await rm(path, { force: true }); }
}

function timestamp(atMs: number): string {
  return new Date(atMs).toISOString().replace(/:/gu, '');
}

function timestampFromName(name: string, fallback: number): number {
  const matched = COMPLETED_NAME.exec(name)?.[1];
  if (!matched) return fallback;
  const iso = matched.replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2})(\d{2})(\d{2}\.\d{3}Z)$/u, '$1$2:$3:$4');
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function snapshotFingerprintInput(relativePath: string, size: number, mtimeNs: string, sha256: string): string {
  return ['database_backup', relativePath, String(size), mtimeNs, sha256]
    .map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('\0');
}
