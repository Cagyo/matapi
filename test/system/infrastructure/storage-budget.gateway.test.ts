import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMERGENCY_RESERVE_BYTES,
  StorageBudgetGateway,
  type StorageBudgetFileSystem,
  type StorageFileHandle,
  type StorageStat,
  type StatVfs,
} from "../../../src/system/infrastructure/storage-budget.gateway";

class FakeStorageFileSystem implements StorageBudgetFileSystem {
  reserveExists = false;
  reserveAllocatedBytes = 0;
  readonly events: string[] = [];
  failAt: "open" | "write" | "sync" | "close" | undefined;

  constructor(
    private readonly reservePath: string,
    private readonly candidatePath: string,
  ) {}

  async lstat(path: string): Promise<StorageStat> {
    if (path !== this.reservePath || !this.reserveExists) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return {
      size: this.reserveAllocatedBytes,
      blocks: this.reserveAllocatedBytes / 512,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    };
  }

  async open(path: string): Promise<StorageFileHandle> {
    if (path !== this.reservePath || this.reserveExists)
      throw new Error("exists");
    if (this.failAt === "open") {
      this.failAt = undefined;
      throw Object.assign(new Error("pressure"), { code: "ENOSPC" });
    }
    this.reserveExists = true;
    this.events.push("reserve-open");
    return {
      write: async (_buffer, _offset, length) => {
        if (this.failAt === "write") {
          this.failAt = undefined;
          throw Object.assign(new Error("pressure"), { code: "ENOSPC" });
        }
        this.reserveAllocatedBytes += length;
        return { bytesWritten: length };
      },
      sync: async () => {
        if (this.failAt === "sync") {
          this.failAt = undefined;
          throw Object.assign(new Error("pressure"), { code: "ENOSPC" });
        }
        this.events.push("reserve-sync");
      },
      close: async () => {
        if (this.failAt === "close") {
          this.failAt = undefined;
          throw Object.assign(new Error("pressure"), { code: "ENOSPC" });
        }
        this.events.push("reserve-close");
      },
    };
  }

  async unlink(path: string): Promise<void> {
    if (path !== this.reservePath || !this.reserveExists) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    this.reserveExists = false;
    this.reserveAllocatedBytes = 0;
    this.events.push("reserve-unlink");
  }

  async removeCandidate(path: string): Promise<void> {
    expect(path).toBe(this.candidatePath);
    await rm(path, { recursive: true, force: true });
    this.events.push("candidate-remove");
  }
}

let sandbox: string;
let candidate: string;
let reserve: string;
let fileSystem: FakeStorageFileSystem;
let snapshots: { availableBytes: number; freeInodes: number }[];
let statvfs: StatVfs;
let barrier: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
let failBarrier: boolean;

function storage(): StorageBudgetGateway {
  return new StorageBudgetGateway({
    filesystemRoot: sandbox,
    reservePath: reserve,
    candidatePath: candidate,
    fixedHeadroomBytes: 100,
    fixedHeadroomInodes: 10,
    fileSystem,
    statvfs,
    barrier,
  });
}

describe("StorageBudgetGateway", () => {
  beforeEach(async () => {
    sandbox = await mkdtemp(resolve(tmpdir(), "storage-budget-"));
    candidate = resolve(sandbox, "candidate");
    reserve = resolve(sandbox, ".ota-emergency-reserve");
    await mkdir(candidate);
    fileSystem = new FakeStorageFileSystem(reserve, candidate);
    snapshots = [
      { availableBytes: Number.MAX_SAFE_INTEGER, freeInodes: 1_000_000 },
    ];
    statvfs = vi.fn(async () => snapshots.shift() ?? snapshots.at(-1)!);
    failBarrier = false;
    barrier = vi.fn(async (path: string) => {
      if (failBarrier) {
        failBarrier = false;
        throw Object.assign(new Error("pressure"), { code: "ENOSPC" });
      }
      fileSystem.events.push(`barrier:${path}`);
    });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("fully allocates and durably flushes the fixed 128 MiB reserve", async () => {
    const gateway = storage();

    await gateway.ensureReserve();

    expect(fileSystem.reserveAllocatedBytes).toBe(EMERGENCY_RESERVE_BYTES);
    expect(fileSystem.events.slice(-3)).toEqual([
      "reserve-sync",
      "reserve-close",
      `barrier:${dirname(reserve)}`,
    ]);
    expect(await gateway.verifyReserve()).toBe(true);
  });

  it("preflights bytes and inodes for all retained and preparation resources", async () => {
    snapshots = [{ availableBytes: 1_400, freeInodes: 40 }];

    await expect(
      storage().preflight({
        compressedBytes: 100,
        declaredExpansionBytes: 200,
        maxPreparedBytes: 300,
        maxPreparedFiles: 10,
        currentReleaseAllocatedBytes: 250,
        currentReleaseEntries: 7,
        previousReleaseAllocatedBytes: 150,
        previousReleaseEntries: 5,
      }),
    ).resolves.toMatchObject({
      requiredBytes: 1_100,
      requiredInodes: 33,
    });
  });

  it.each(["open", "write", "sync", "close", "barrier"] as const)(
    "maps reserve %s pressure during preflight and restores a complete reserve",
    async (boundary) => {
      if (boundary === "barrier") failBarrier = true;
      else fileSystem.failAt = boundary;
      const gateway = storage();

      await expect(
        gateway.preflight({
          compressedBytes: 100,
          declaredExpansionBytes: 200,
          maxPreparedBytes: 300,
          maxPreparedFiles: 10,
          currentReleaseAllocatedBytes: 250,
          currentReleaseEntries: 7,
          previousReleaseAllocatedBytes: 150,
          previousReleaseEntries: 5,
        }),
      ).rejects.toMatchObject({ code: "disk-resource" });
      expect(await gateway.verifyReserve()).toBe(true);
    },
  );

  it.each([
    [{ availableBytes: 1_099, freeInodes: 40 }, "bytes"],
    [{ availableBytes: 1_400, freeInodes: 32 }, "inodes"],
  ])("rejects insufficient preflight %s", async (snapshot) => {
    snapshots = [snapshot];

    await expect(
      storage().preflight({
        compressedBytes: 100,
        declaredExpansionBytes: 200,
        maxPreparedBytes: 300,
        maxPreparedFiles: 10,
        currentReleaseAllocatedBytes: 250,
        currentReleaseEntries: 7,
        previousReleaseAllocatedBytes: 150,
        previousReleaseEntries: 5,
      }),
    ).rejects.toMatchObject({ code: "disk-resource" });
  });

  it.each([
    { availableBytes: 99, freeInodes: 100 },
    { availableBytes: 1_000, freeInodes: 9 },
  ])(
    "releases reserve, aborts, cleans candidate, and recreates reserve at low water",
    async (lowWater) => {
      snapshots = [
        { availableBytes: 1_000, freeInodes: 100 },
        lowWater,
        { availableBytes: 1_000, freeInodes: 100 },
      ];
      const gateway = storage();
      const operation = async (checkpoint: () => Promise<void>) => {
        await checkpoint();
      };

      await expect(
        gateway.enforceDuringPreparation(operation),
      ).rejects.toMatchObject({ code: "disk-resource" });
      expect(existsSync(candidate)).toBe(false);
      expect(await gateway.verifyReserve()).toBe(true);
      expect(fileSystem.events.indexOf("reserve-unlink")).toBeLessThan(
        fileSystem.events.indexOf("candidate-remove"),
      );
      expect(fileSystem.events.lastIndexOf("reserve-open")).toBeGreaterThan(
        fileSystem.events.indexOf("candidate-remove"),
      );
    },
  );

  it.each(["ENOSPC", "EDQUOT"])(
    "recovers the reserve and candidate after injected %s persistence failure",
    async (code) => {
      const gateway = storage();

      await expect(
        gateway.enforceDuringPreparation(async () => {
          throw Object.assign(new Error("pressure"), { code });
        }),
      ).rejects.toMatchObject({ code: "disk-resource" });
      expect(existsSync(candidate)).toBe(false);
      expect(await gateway.verifyReserve()).toBe(true);
    },
  );
});
