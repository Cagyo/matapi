import { constants } from "node:fs";
import {
  lstat as nodeLstat,
  open as nodeOpen,
  rm as nodeRm,
  statfs as nodeStatfs,
  unlink as nodeUnlink,
} from "node:fs/promises";
import { dirname } from "node:path";

export const EMERGENCY_RESERVE_BYTES = 128 * 1024 * 1024;
const ALLOCATION_CHUNK_BYTES = 1024 * 1024;

export class DiskResourceError extends Error {
  readonly code = "disk-resource" as const;

  constructor() {
    super("OTA storage resources are insufficient");
    this.name = "DiskResourceError";
  }
}

export interface StorageResourceSnapshot {
  availableBytes: number;
  freeInodes: number;
}

export type StatVfs = (path: string) => Promise<StorageResourceSnapshot>;

export interface StorageStat {
  size: number;
  blocks: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface StorageFileHandle {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface StorageBudgetFileSystem {
  lstat(path: string): Promise<StorageStat>;
  open(path: string, flags: number, mode: number): Promise<StorageFileHandle>;
  unlink(path: string): Promise<void>;
  removeCandidate(path: string): Promise<void>;
}

const NODE_STORAGE_FILE_SYSTEM: StorageBudgetFileSystem = {
  lstat: nodeLstat,
  open: nodeOpen,
  unlink: nodeUnlink,
  removeCandidate: async (path) => {
    let entry: StorageStat;
    try {
      entry = await nodeLstat(path);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await nodeRm(path, { recursive: true, force: true });
    } else {
      await nodeUnlink(path);
    }
  },
};

const NODE_STAT_VFS: StatVfs = async (path) => {
  const stats = await nodeStatfs(path);
  return {
    availableBytes: checkedProduct(stats.bavail, stats.bsize),
    freeInodes: stats.ffree,
  };
};

export interface StoragePreflightInput {
  compressedBytes: number;
  declaredExpansionBytes: number;
  maxPreparedBytes: number;
  maxPreparedFiles: number;
  currentReleaseAllocatedBytes: number;
  currentReleaseEntries: number;
  previousReleaseAllocatedBytes: number;
  previousReleaseEntries: number;
}

export interface StoragePreflightResult extends StorageResourceSnapshot {
  requiredBytes: number;
  requiredInodes: number;
}

export interface StorageCheckpointRequirement {
  requiredBytes?: number;
  requiredInodes?: number;
}

export type StorageCheckpoint = (
  requirement?: StorageCheckpointRequirement,
) => Promise<void>;

export interface StorageBudgetGatewayOptions {
  filesystemRoot: string;
  reservePath: string;
  candidatePath: string;
  fixedHeadroomBytes: number;
  fixedHeadroomInodes: number;
  fileSystem?: StorageBudgetFileSystem;
  statvfs?: StatVfs;
  barrier: (directory: string) => Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isResourceFailure(error: unknown): boolean {
  return (
    error instanceof DiskResourceError ||
    hasCode(error, "ENOSPC") ||
    hasCode(error, "EDQUOT")
  );
}

function checkedValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new DiskResourceError();
  return value;
}

function checkedSum(values: readonly number[]): number {
  return values.reduce((sum, value) => {
    const result = sum + checkedValue(value);
    if (!Number.isSafeInteger(result)) throw new DiskResourceError();
    return result;
  }, 0);
}

function checkedProduct(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new DiskResourceError();
  return result;
}

export class StorageBudgetGateway {
  private readonly fileSystem: StorageBudgetFileSystem;
  private readonly statvfs: StatVfs;

  constructor(private readonly options: StorageBudgetGatewayOptions) {
    checkedValue(options.fixedHeadroomBytes);
    checkedValue(options.fixedHeadroomInodes);
    this.fileSystem = options.fileSystem ?? NODE_STORAGE_FILE_SYSTEM;
    this.statvfs = options.statvfs ?? NODE_STAT_VFS;
  }

  async ensureReserve(): Promise<void> {
    if (await this.verifyReserve()) return;
    if (await this.reserveExists()) throw new DiskResourceError();

    try {
      await this.establishReserve();
    } catch (error) {
      if (!isResourceFailure(error)) throw error;
      await this.recoverReserveEstablishment();
      throw new DiskResourceError();
    }
  }

  private async establishReserve(): Promise<void> {
    const handle = await this.fileSystem.open(
      this.options.reservePath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const chunk = Buffer.alloc(ALLOCATION_CHUNK_BYTES);
      let position = 0;
      while (position < EMERGENCY_RESERVE_BYTES) {
        const length = Math.min(
          chunk.length,
          EMERGENCY_RESERVE_BYTES - position,
        );
        const { bytesWritten } = await handle.write(chunk, 0, length, position);
        if (bytesWritten <= 0 || bytesWritten > length) {
          throw new DiskResourceError();
        }
        position += bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.options.barrier(dirname(this.options.reservePath));
    if (!(await this.verifyReserve())) throw new DiskResourceError();
  }

  private async recoverReserveEstablishment(): Promise<void> {
    try {
      await this.removeReserveForRecovery();
      await this.establishReserve();
    } catch {
      try {
        await this.removeReserveForRecovery();
      } catch {
        // The original resource failure remains the public classification.
      }
    }
  }

  private async removeReserveForRecovery(): Promise<void> {
    let entry: StorageStat;
    try {
      entry = await this.fileSystem.lstat(this.options.reservePath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      throw new DiskResourceError();
    }
    await this.fileSystem.unlink(this.options.reservePath);
    await this.options.barrier(dirname(this.options.reservePath));
  }

  async verifyReserve(): Promise<boolean> {
    try {
      const entry = await this.fileSystem.lstat(this.options.reservePath);
      return (
        entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.size === EMERGENCY_RESERVE_BYTES &&
        checkedProduct(entry.blocks, 512) >= EMERGENCY_RESERVE_BYTES
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      if (error instanceof DiskResourceError) return false;
      throw error;
    }
  }

  async preflight(
    input: StoragePreflightInput,
  ): Promise<StoragePreflightResult> {
    await this.ensureReserve();
    const requiredBytes = checkedSum([
      input.compressedBytes,
      input.declaredExpansionBytes,
      input.maxPreparedBytes,
      input.currentReleaseAllocatedBytes,
      input.previousReleaseAllocatedBytes,
      this.options.fixedHeadroomBytes,
    ]);
    const requiredInodes = checkedSum([
      1,
      input.maxPreparedFiles,
      input.currentReleaseEntries,
      input.previousReleaseEntries,
      this.options.fixedHeadroomInodes,
    ]);
    const available = await this.readResources();
    if (
      available.availableBytes < requiredBytes ||
      available.freeInodes < requiredInodes
    ) {
      throw new DiskResourceError();
    }
    return { ...available, requiredBytes, requiredInodes };
  }

  async enforceDuringPreparation<T>(
    operation: (checkpoint: StorageCheckpoint) => Promise<T>,
  ): Promise<T> {
    const checkpoint: StorageCheckpoint = (requirement = {}) =>
      this.checkpoint(requirement);
    try {
      await this.ensureReserve();
      await checkpoint();
      const result = await operation(checkpoint);
      await checkpoint();
      return result;
    } catch (error) {
      if (!isResourceFailure(error)) throw error;
      try {
        await this.recoverEmergencyReserve();
      } catch {
        // The public failure remains deliberately diagnostic-free.
      }
      throw new DiskResourceError();
    }
  }

  private async checkpoint(
    requirement: StorageCheckpointRequirement,
  ): Promise<void> {
    const available = await this.readResources();
    const requiredBytes = checkedSum([
      this.options.fixedHeadroomBytes,
      requirement.requiredBytes ?? 0,
    ]);
    const requiredInodes = checkedSum([
      this.options.fixedHeadroomInodes,
      requirement.requiredInodes ?? 0,
    ]);
    if (
      available.availableBytes < requiredBytes ||
      available.freeInodes < requiredInodes
    ) {
      throw new DiskResourceError();
    }
  }

  private async readResources(): Promise<StorageResourceSnapshot> {
    try {
      const snapshot = await this.statvfs(this.options.filesystemRoot);
      return {
        availableBytes: checkedValue(snapshot.availableBytes),
        freeInodes: checkedValue(snapshot.freeInodes),
      };
    } catch (error) {
      if (isResourceFailure(error)) throw new DiskResourceError();
      throw error;
    }
  }

  private async recoverEmergencyReserve(): Promise<void> {
    if (await this.reserveExists()) {
      await this.fileSystem.unlink(this.options.reservePath);
      await this.options.barrier(dirname(this.options.reservePath));
    }
    await this.fileSystem.removeCandidate(this.options.candidatePath);
    await this.options.barrier(dirname(this.options.candidatePath));
    await this.ensureReserve();
  }

  private async reserveExists(): Promise<boolean> {
    try {
      await this.fileSystem.lstat(this.options.reservePath);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  }
}
