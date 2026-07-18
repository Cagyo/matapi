import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat as nodeLstat,
  open as nodeOpen,
  readdir as nodeReaddir,
  readlink as nodeReadlink,
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  canonicalPreparedTreeSha256,
  isUpdaterMarkerPath,
  normalizePreparedTreeMode,
  PreparedTreeError,
  type PreparedTreeGateway,
  type PreparedTreeMeasurement,
  type PreparedTreeRecord,
} from "../domain/prepared-tree";

const READ_BUFFER_BYTES = 64 * 1024;

export interface PreparedTreeFileHandle {
  stat(): Promise<Stats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface PreparedTreeFileSystem {
  lstat(path: string): Promise<Stats>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  open(path: string, flags: number): Promise<PreparedTreeFileHandle>;
}

const NODE_FILE_SYSTEM: PreparedTreeFileSystem = {
  lstat: nodeLstat,
  readdir: (path) => nodeReaddir(path),
  readlink: nodeReadlink,
  open: nodeOpen,
};

export type PreparedTreeBarrier = (root: string) => Promise<void>;

export interface NodePreparedTreeGatewayOptions {
  fileSystem?: PreparedTreeFileSystem;
  barrier?: PreparedTreeBarrier;
}

function sameEntry(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function checkedAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new PreparedTreeError("prepared tree resource count overflowed");
  }
  return total;
}

export class NodePreparedTreeGateway implements PreparedTreeGateway {
  private readonly fileSystem: PreparedTreeFileSystem;
  private readonly barrier: PreparedTreeBarrier | undefined;

  constructor(options: NodePreparedTreeGatewayOptions = {}) {
    this.fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM;
    this.barrier = options.barrier;
  }

  async measureAndDigest(root: string): Promise<PreparedTreeMeasurement> {
    try {
      await this.assertStableDirectory(root);
      const records: PreparedTreeRecord[] = [];
      let allocatedBytes = 0;
      let entryCount = 0;

      const walk = async (directory: string, relativeDirectory: string) => {
        const before = await this.fileSystem.lstat(directory);
        if (!before.isDirectory() || before.isSymbolicLink()) {
          throw new PreparedTreeError("prepared tree directory changed type");
        }
        await this.assertStableDirectory(directory, before);

        const names = await this.fileSystem.readdir(directory);
        for (const name of names) {
          if (
            name === "" ||
            name === "." ||
            name === ".." ||
            name.includes("/")
          ) {
            throw new PreparedTreeError(
              "prepared tree contains an invalid child name",
            );
          }
          const relativePath = relativeDirectory
            ? `${relativeDirectory}/${name}`
            : name;
          const path = resolve(directory, name);
          const beforeEntry = await this.fileSystem.lstat(path);

          if (
            isUpdaterMarkerPath(relativePath) &&
            beforeEntry.isFile() &&
            !beforeEntry.isSymbolicLink()
          ) {
            continue;
          }

          const allocated = checkedAdd(0, beforeEntry.blocks * 512);
          allocatedBytes = checkedAdd(allocatedBytes, allocated);
          entryCount = checkedAdd(entryCount, 1);
          const normalizedMode = normalizePreparedTreeMode(beforeEntry.mode);

          if (beforeEntry.isDirectory() && !beforeEntry.isSymbolicLink()) {
            records.push({
              relativePath,
              entryType: "directory",
              normalizedMode,
              contentIdentity: "",
            });
            await walk(path, relativePath);
          } else if (beforeEntry.isFile() && !beforeEntry.isSymbolicLink()) {
            records.push({
              relativePath,
              entryType: "file",
              normalizedMode,
              contentIdentity: await this.hashRegularFile(path, beforeEntry),
            });
          } else if (beforeEntry.isSymbolicLink()) {
            const linkTarget = await this.fileSystem.readlink(path);
            const afterEntry = await this.fileSystem.lstat(path);
            if (!sameEntry(beforeEntry, afterEntry)) {
              throw new PreparedTreeError(
                "prepared tree link changed while reading",
              );
            }
            records.push({
              relativePath,
              entryType: "symlink",
              normalizedMode,
              contentIdentity: linkTarget,
            });
          } else {
            throw new PreparedTreeError(
              "prepared tree contains a special entry",
            );
          }
        }

        const after = await this.fileSystem.lstat(directory);
        if (!sameEntry(before, after)) {
          throw new PreparedTreeError("prepared tree changed while traversing");
        }
      };

      await walk(root, "");
      return {
        allocatedBytes,
        entryCount,
        sha256: canonicalPreparedTreeSha256(records),
      };
    } catch (error) {
      if (error instanceof PreparedTreeError) throw error;
      throw new PreparedTreeError("prepared tree could not be measured");
    }
  }

  async flushDurably(root: string): Promise<void> {
    if (this.barrier === undefined) {
      throw new PreparedTreeError(
        "prepared tree filesystem barrier is required",
      );
    }
    try {
      await this.assertStableDirectory(root);
      const walk = async (directory: string): Promise<void> => {
        const names = await this.fileSystem.readdir(directory);
        for (const name of names) {
          const path = resolve(directory, name);
          const entry = await this.fileSystem.lstat(path);
          if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await this.assertStableDirectory(path, entry);
            await walk(path);
          } else if (entry.isFile() && !entry.isSymbolicLink()) {
            const handle = await this.fileSystem.open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const opened = await handle.stat();
              if (!sameEntry(entry, opened)) {
                throw new PreparedTreeError(
                  "prepared tree file changed before durable flush",
                );
              }
              await handle.sync();
            } finally {
              await handle.close();
            }
          } else if (!entry.isSymbolicLink()) {
            throw new PreparedTreeError(
              "prepared tree contains a special entry",
            );
          }
        }
        await this.syncDirectory(directory);
      };

      await walk(root);
      await this.barrier(root);
    } catch (error) {
      if (error instanceof PreparedTreeError) throw error;
      throw new PreparedTreeError("prepared tree durable flush failed");
    }
  }

  private async hashRegularFile(path: string, before: Stats): Promise<string> {
    const handle = await this.fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (!sameEntry(before, opened) || !opened.isFile()) {
        throw new PreparedTreeError(
          "prepared tree file changed before hashing",
        );
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
      let position = 0;
      while (position < opened.size) {
        const requested = Math.min(buffer.length, opened.size - position);
        const { bytesRead } = await handle.read(buffer, 0, requested, position);
        if (bytesRead <= 0) {
          throw new PreparedTreeError("prepared tree file ended while hashing");
        }
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await handle.stat();
      if (!sameEntry(opened, after)) {
        throw new PreparedTreeError("prepared tree file changed while hashing");
      }
      return hash.digest("hex");
    } finally {
      await handle.close();
    }
  }

  private async assertStableDirectory(
    path: string,
    expected?: Stats,
  ): Promise<void> {
    const before = expected ?? (await this.fileSystem.lstat(path));
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new PreparedTreeError("prepared tree root must be a directory");
    }
    const handle = await this.fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || !sameEntry(before, opened)) {
        throw new PreparedTreeError(
          "prepared tree directory changed while opening",
        );
      }
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await this.fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
