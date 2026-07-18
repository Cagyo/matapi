import { readFile, rm, stat, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  sha256,
  writeOtaArchiveFixtures,
} from "../../fixtures/ota/archives/archive-fixtures";
import { inspectYarnCache } from "../../../src/system/infrastructure/yarn-cache-inspector";

const root = resolve("test/.tmp/ota-task-8/cache");
const fixtures = join(root, "fixtures");
const limits = { maxEntries: 20, maxExpandedBytes: 128 };

describe("inspectYarnCache", () => {
  beforeAll(async () => {
    await rm(root, { recursive: true, force: true });
    await writeOtaArchiveFixtures(fixtures);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lazily validates cache ZIPs and returns canonical digest records", async () => {
    const cacheRoot = join(fixtures, "cache-cases/valid.zip");
    const bytes = await readFile(join(cacheRoot, "valid.zip"));

    await expect(inspectYarnCache(cacheRoot, limits)).resolves.toEqual({
      archives: [
        {
          path: "valid.zip",
          size: bytes.length,
          sha256: sha256(bytes),
        },
      ],
      entryCount: 2,
      expandedBytes: 30,
    });
  });

  it.each([
    "encrypted.zip",
    "traversal.zip",
    "duplicate.zip",
    "bomb.zip",
    "unsupported-method.zip",
  ])("rejects Yarn cache fixture %s", async (fixture) => {
    await expect(
      inspectYarnCache(join(fixtures, "cache-cases", fixture), limits),
    ).rejects.toMatchObject({ code: "archive-policy" });
  });

  it("rejects cache files reached through a symlink", async () => {
    const source = join(fixtures, "cache-cases/valid.zip/valid.zip");
    const cacheRoot = join(root, "symlink-cache");
    await symlink(resolve(source), cacheRoot);

    await expect(inspectYarnCache(cacheRoot, limits)).rejects.toMatchObject({
      code: "archive-policy",
    });
    expect((await stat(source)).isFile()).toBe(true);
  });
});
