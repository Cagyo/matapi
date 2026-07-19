import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createDeterministicTarGz,
  validateDeterministicTarGz,
  writeDeterministicArchive,
} from "../../../scripts/release/archive-writer.mjs";
import { computeCacheInventorySha256 } from "../../../scripts/release/release-policy.mjs";

const EPOCH = 1_725_000_000;
const hash = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

async function write(root: string, path: string, contents: string | Buffer) {
  const destination = join(root, path);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, contents, { mode: 0o600 });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "home-worker-release-fixture-"));
  const cacheFiles = [
    [".yarn/cache/a-package-npm-1.0.0.zip", Buffer.from("cache-a")],
    [".yarn/cache/z-package-npm-2.0.0.zip", Buffer.from("cache-z")],
  ] as const;

  await write(root, "package.json", '{"name":"fixture","version":"1.2.3"}\n');
  await write(root, "yarn.lock", "# fixture lock\n");
  await write(root, ".yarnrc.yml", "enableNetwork: false\n");
  await write(root, "config/defaults.yml", "timezone: UTC\n");
  await write(root, ".yarn/releases/yarn-4.13.0.cjs", "/* fixture yarn */\n");
  await write(root, "dist/main.js", "export {};\n");
  await write(root, "dist/z.js", "z\n");
  await write(root, "dist/alpha.js", "a\n");
  await write(root, "migrations/0001_fixture.sql", "select 1;\n");
  await write(root, "migrations/meta/_journal.json", "{}\n");
  await write(root, "scripts/rollback.sh", "#!/bin/sh\nexit 0\n");
  await write(root, "scripts/system-update.sh", "#!/bin/sh\nexit 0\n");
  await write(root, "scripts/update.sh", "#!/bin/sh\nexit 0\n");
  for (const [path, contents] of cacheFiles) await write(root, path, contents);

  const cacheInventory = cacheFiles.map(([path, contents]) => ({
    path,
    size: contents.length,
    sha256: hash(contents),
  }));
  return {
    root,
    cacheInventory,
    cacheInventorySha256: computeCacheInventorySha256(cacheInventory),
  };
}

describe("deterministic release archive writer", () => {
  it("emits identical gzip bytes with canonical paths and metadata", async () => {
    const { root, cacheInventory } = await fixture();
    const first = await createDeterministicTarGz({
      root,
      sourceDateEpoch: EPOCH,
      expectedCacheInventory: cacheInventory,
    });
    const second = await createDeterministicTarGz({
      root,
      sourceDateEpoch: EPOCH,
      expectedCacheInventory: [...cacheInventory].reverse(),
    });

    expect(first.bytes).toEqual(second.bytes);
    const inspected = validateDeterministicTarGz({
      bytes: first.bytes,
      sourceDateEpoch: EPOCH,
      expectedInventory: first.inventory,
    });
    expect(inspected.map((entry: { path: string }) => entry.path)).toEqual(
      [...inspected]
        .map((entry: { path: string }) => entry.path)
        .sort((left, right) =>
          Buffer.compare(Buffer.from(left), Buffer.from(right)),
        ),
    );
    expect(
      inspected.find(
        (entry: { path: string }) => entry.path === "package.json",
      ),
    ).toMatchObject({
      type: "file",
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: EPOCH,
    });
    expect(
      inspected.find(
        (entry: { path: string }) => entry.path === "scripts/update.sh",
      ),
    ).toMatchObject({
      type: "file",
      mode: 0o755,
    });
  });

  it("rejects links and unsafe source modes", async () => {
    const linked = await fixture();
    await symlink("main.js", join(linked.root, "dist/linked.js"));
    await expect(
      createDeterministicTarGz({
        root: linked.root,
        sourceDateEpoch: EPOCH,
        expectedCacheInventory: linked.cacheInventory,
      }),
    ).rejects.toThrow(/symbolic link/i);

    const writable = await fixture();
    await chmod(join(writable.root, "dist/main.js"), 0o666);
    await expect(
      createDeterministicTarGz({
        root: writable.root,
        sourceDateEpoch: EPOCH,
        expectedCacheInventory: writable.cacheInventory,
      }),
    ).rejects.toThrow(/unsafe mode/i);
  });

  it.each([
    ".env",
    "data/worker.db",
    "dist/private.pem",
    "tests/dev-only.js",
    "dist/control\nname.js",
    "artifact-state.json",
  ])("rejects denied or unlisted path %s", async (path) => {
    const candidate = await fixture();
    await write(candidate.root, path, "must not ship\n");
    await expect(
      createDeterministicTarGz({
        root: candidate.root,
        sourceDateEpoch: EPOCH,
        expectedCacheInventory: candidate.cacheInventory,
      }),
    ).rejects.toThrow(/denied|allowlist|unsafe/i);
  });

  it("rejects cache inventory mutations before emitting output", async () => {
    const candidate = await fixture();
    await write(
      candidate.root,
      candidate.cacheInventory[0].path,
      "mutated-cache-contents",
    );
    const outputPath = join(
      candidate.root,
      "..",
      `candidate-${Date.now()}.tar.gz`,
    );

    await expect(
      writeDeterministicArchive({
        root: candidate.root,
        outputPath,
        sourceDateEpoch: EPOCH,
        expectedCacheInventory: candidate.cacheInventory,
      }),
    ).rejects.toThrow(/cache inventory/i);
    await expect(readFile(outputPath)).rejects.toThrow();
  });

  it("writes through an exclusive atomic destination", async () => {
    const candidate = await fixture();
    const outputPath = join(
      candidate.root,
      "..",
      `candidate-${Date.now()}.tar.gz`,
    );
    const result = await writeDeterministicArchive({
      root: candidate.root,
      outputPath,
      sourceDateEpoch: EPOCH,
      expectedCacheInventory: candidate.cacheInventory,
    });

    expect(hash(await readFile(outputPath))).toBe(result.sha256);
    await expect(
      writeDeterministicArchive({
        root: candidate.root,
        outputPath,
        sourceDateEpoch: EPOCH,
        expectedCacheInventory: candidate.cacheInventory,
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it.each(["after-link", "before-parent-fsync"] as const)(
    "removes a linked output when publication fails at %s",
    async (faultInjection) => {
      const candidate = await fixture();
      const outputPath = join(
        candidate.root,
        "..",
        `candidate-fault-${faultInjection}-${Date.now()}.tar.gz`,
      );

      await expect(
        writeDeterministicArchive({
          root: candidate.root,
          outputPath,
          sourceDateEpoch: EPOCH,
          expectedCacheInventory: candidate.cacheInventory,
          faultInjection,
        }),
      ).rejects.toThrow(/injected publication failure/i);
      await expect(readFile(outputPath)).rejects.toThrow();
    },
  );
});
