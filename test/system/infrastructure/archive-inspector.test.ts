import { lstat, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeOtaArchiveFixtures } from "../../fixtures/ota/archives/archive-fixtures";
import { inspectAndExtractTarGz } from "../../../src/system/infrastructure/archive-inspector";

const root = resolve("test/.tmp/ota-task-8/archive");
const fixtures = join(root, "fixtures");

function input(fixture: string, destinationRoot: string) {
  return {
    archivePath: join(fixtures, fixture),
    destinationRoot,
    expected: { entryCount: 4, regularBytes: 19 },
    limits: {
      maxEntries: 20,
      maxExpandedBytes: 1024,
    },
  };
}

const hostileExpected: Record<
  string,
  { entryCount: number; regularBytes: number }
> = {
  "absolute.tar.gz": { entryCount: 1, regularBytes: 1 },
  "dotdot.tar.gz": { entryCount: 1, regularBytes: 1 },
  "symlink.tar.gz": { entryCount: 1, regularBytes: 0 },
  "hardlink.tar.gz": { entryCount: 1, regularBytes: 0 },
  "device.tar.gz": { entryCount: 1, regularBytes: 0 },
  "fifo.tar.gz": { entryCount: 1, regularBytes: 0 },
  "sparse.tar.gz": { entryCount: 1, regularBytes: 0 },
  "pax.tar.gz": { entryCount: 1, regularBytes: 1 },
  "duplicate.tar.gz": { entryCount: 2, regularBytes: 2 },
  "control-char.tar.gz": { entryCount: 1, regularBytes: 1 },
  "invalid-utf8.tar.gz": { entryCount: 1, regularBytes: 1 },
  "setuid.tar.gz": { entryCount: 1, regularBytes: 1 },
  "world-writable.tar.gz": { entryCount: 1, regularBytes: 1 },
  "truncated.tar.gz": { entryCount: 4, regularBytes: 19 },
  "trailing-data.tar.gz": { entryCount: 4, regularBytes: 19 },
  "trailing-tar-data.tar.gz": { entryCount: 4, regularBytes: 19 },
};

describe("inspectAndExtractTarGz", () => {
  beforeAll(async () => {
    await rm(root, { recursive: true, force: true });
    await writeOtaArchiveFixtures(fixtures);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("streams a valid archive into a private candidate and normalizes modes", async () => {
    const destination = join(root, "valid-candidate");
    const inventory = await inspectAndExtractTarGz(
      input("valid.tar.gz", destination),
    );

    expect(inventory).toEqual({
      entryCount: 4,
      regularFileCount: 2,
      regularBytes: 19,
    });
    expect(await readFile(join(destination, "dist/main.js"), "utf8")).toBe(
      "ok",
    );
    expect((await stat(join(destination, "dist"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(destination, "dist/main.js"))).mode & 0o777).toBe(
      0o644,
    );
    expect(
      (await stat(join(destination, "scripts/update.sh"))).mode & 0o777,
    ).toBe(0o755);
  });

  it.each([
    "absolute.tar.gz",
    "dotdot.tar.gz",
    "symlink.tar.gz",
    "hardlink.tar.gz",
    "device.tar.gz",
    "fifo.tar.gz",
    "sparse.tar.gz",
    "pax.tar.gz",
    "duplicate.tar.gz",
    "control-char.tar.gz",
    "invalid-utf8.tar.gz",
    "setuid.tar.gz",
    "world-writable.tar.gz",
    "truncated.tar.gz",
    "trailing-data.tar.gz",
    "trailing-tar-data.tar.gz",
  ])("rejects hostile archive fixture %s", async (fixture) => {
    const request = input(fixture, join(root, `candidate-${fixture}`));
    request.expected = hostileExpected[fixture];
    await expect(inspectAndExtractTarGz(request)).rejects.toMatchObject({
      code: "archive-policy",
    });
  });

  it("rejects an archive whose signed entry count differs", async () => {
    const request = input("valid.tar.gz", join(root, "wrong-count"));
    request.expected.entryCount = 3;
    await expect(inspectAndExtractTarGz(request)).rejects.toMatchObject({
      code: "archive-policy",
    });
  });

  it("rejects an archive whose signed expanded size differs", async () => {
    const request = input("valid.tar.gz", join(root, "wrong-size"));
    request.expected.regularBytes = 18;
    await expect(inspectAndExtractTarGz(request)).rejects.toMatchObject({
      code: "archive-policy",
    });
  });

  it("rejects an archive above the configured entry bound", async () => {
    const request = input("valid.tar.gz", join(root, "entry-limit"));
    request.expected.entryCount = 3;
    request.limits.maxEntries = 3;
    await expect(inspectAndExtractTarGz(request)).rejects.toMatchObject({
      code: "archive-policy",
    });
  });

  it("rejects an archive above the configured expanded-byte bound", async () => {
    const request = input("valid.tar.gz", join(root, "expanded-limit"));
    request.expected.regularBytes = 18;
    request.limits.maxExpandedBytes = 18;
    await expect(inspectAndExtractTarGz(request)).rejects.toMatchObject({
      code: "archive-policy",
    });
  });

  it("does not follow a pre-existing candidate symlink", async () => {
    const destination = join(root, "symlink-candidate");
    const outside = join(root, "outside");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(destination, "dist"));

    await expect(
      inspectAndExtractTarGz(input("valid.tar.gz", destination)),
    ).rejects.toMatchObject({ code: "archive-policy" });
    await expect(lstat(join(outside, "main.js"))).rejects.toThrow();
  });
});
