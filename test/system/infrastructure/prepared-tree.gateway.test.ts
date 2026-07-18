import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NodePreparedTreeGateway,
  type PreparedTreeFileSystem,
} from "../../../src/system/infrastructure/prepared-tree.gateway";

let sandbox: string;
let candidate: string;
let outside: string;

async function makeCandidate(): Promise<void> {
  candidate = resolve(sandbox, "candidate");
  outside = resolve(sandbox, "outside");
  await mkdir(resolve(candidate, "dist"), { recursive: true, mode: 0o755 });
  await writeFile(resolve(candidate, "dist/main.js"), "hello", { mode: 0o644 });
  await writeFile(resolve(candidate, "kind"), "file", { mode: 0o644 });
  await writeFile(outside, "not part of the candidate", { mode: 0o644 });
  await symlink("dist/main.js", resolve(candidate, "entrypoint"));
}

describe("NodePreparedTreeGateway", () => {
  beforeEach(async () => {
    sandbox = await mkdtemp(resolve(tmpdir(), "prepared-tree-"));
    await makeCandidate();
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it.each(["bytes", "mode", "type", "link-target"])(
    "detects changed prepared %s",
    async (mutation) => {
      const gateway = new NodePreparedTreeGateway();
      const before = await gateway.measureAndDigest(candidate);

      if (mutation === "bytes") {
        await writeFile(resolve(candidate, "dist/main.js"), "changed");
      } else if (mutation === "mode") {
        await chmod(resolve(candidate, "dist/main.js"), 0o600);
      } else if (mutation === "type") {
        await unlink(resolve(candidate, "kind"));
        await mkdir(resolve(candidate, "kind"));
      } else {
        await unlink(resolve(candidate, "entrypoint"));
        await symlink("kind", resolve(candidate, "entrypoint"));
      }

      expect((await gateway.measureAndDigest(candidate)).sha256).not.toBe(
        before.sha256,
      );
    },
  );

  it("excludes only updater marker files from the tree digest and totals", async () => {
    const gateway = new NodePreparedTreeGateway();
    const before = await gateway.measureAndDigest(candidate);
    await writeFile(resolve(candidate, "artifact-state.json"), "state");
    await writeFile(resolve(candidate, "artifact-envelope.json"), "envelope");
    await writeFile(resolve(candidate, "known-good.json"), "healthy");

    expect(await gateway.measureAndDigest(candidate)).toEqual(before);

    await writeFile(
      resolve(candidate, "dist/artifact-state.json"),
      "application",
    );
    expect((await gateway.measureAndDigest(candidate)).sha256).not.toBe(
      before.sha256,
    );
  });

  it("includes a non-file entry that reuses an updater marker name", async () => {
    const gateway = new NodePreparedTreeGateway();
    const before = await gateway.measureAndDigest(candidate);
    await mkdir(resolve(candidate, "known-good.json"));

    expect((await gateway.measureAndDigest(candidate)).sha256).not.toBe(
      before.sha256,
    );
  });

  it("counts allocated stat blocks and entries without following links", async () => {
    await symlink(outside, resolve(candidate, "outside-link"));
    const gateway = new NodePreparedTreeGateway();
    const measured = await gateway.measureAndDigest(candidate);
    const paths = [
      "dist",
      "dist/main.js",
      "kind",
      "entrypoint",
      "outside-link",
    ];
    const stats = await Promise.all(
      paths.map((path) => lstat(resolve(candidate, path))),
    );

    expect(measured).toMatchObject({
      allocatedBytes: stats.reduce((sum, stat) => sum + stat.blocks * 512, 0),
      entryCount: paths.length,
    });
  });

  it("rejects a symlink root", async () => {
    const alias = resolve(sandbox, "alias");
    await symlink(candidate, alias);

    await expect(
      new NodePreparedTreeGateway().measureAndDigest(alias),
    ).rejects.toMatchObject({ code: "prepared-tree" });
  });

  it("syncs every regular file and directory before the injected barrier", async () => {
    await writeFile(resolve(candidate, "artifact-state.json"), "state");
    const events: string[] = [];
    const fileSystem: PreparedTreeFileSystem = {
      lstat,
      readdir: (path) => readdir(path),
      readlink,
      open: async (path, flags) => {
        const handle = await open(path, flags);
        return {
          stat: () => handle.stat(),
          read: (buffer, offset, length, position) =>
            handle.read(buffer, offset, length, position),
          sync: async () => {
            events.push(
              `sync:${resolve(String(path)).slice(candidate.length + 1)}`,
            );
            await handle.sync();
          },
          close: () => handle.close(),
        };
      },
    };
    const barrier = vi.fn(async (root: string) => {
      events.push(`barrier:${root}`);
    });

    await new NodePreparedTreeGateway({ fileSystem, barrier }).flushDurably(
      candidate,
    );

    expect(events.filter((event) => event.startsWith("sync:"))).toHaveLength(5);
    expect(events.at(-1)).toBe(`barrier:${candidate}`);
    expect(barrier).toHaveBeenCalledOnce();
  });

  it("opens traversed entries with no-follow flags", async () => {
    const flags: number[] = [];
    const fileSystem: PreparedTreeFileSystem = {
      lstat,
      readdir: (path) => readdir(path),
      readlink,
      open: async (path, value) => {
        flags.push(value);
        return open(path, value);
      },
    };

    await new NodePreparedTreeGateway({ fileSystem }).measureAndDigest(
      candidate,
    );

    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((value) => (value & constants.O_NOFOLLOW) !== 0)).toBe(
      true,
    );
  });
});
