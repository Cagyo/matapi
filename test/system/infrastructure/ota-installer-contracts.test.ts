import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRootPolicy,
  loadOperationJournal,
  writeRootPolicy,
} from "../../../installer/ota-contracts.mjs";

const roots: string[] = [];
const policy = {
  feedUrl:
    "https://updates.example.test/home-worker/stable/linux-armv7-glibc/update-envelope.json",
  channel: "stable",
  target: {
    targetName: "linux-armv7-glibc",
    platform: "linux",
    arch: "arm",
    libc: "glibc",
    libcVersion: "2.36",
    nodeModulesAbi: "115",
  },
  runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
  limits: {
    maxArtifactBytes: 100,
    maxExpandedBytes: 200,
    maxPreparedBytes: 300,
    maxPreparedFiles: 400,
    maxFiles: 50,
  },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function target() {
  const root = await mkdtemp(resolve(tmpdir(), "ota-policy-"));
  roots.push(root);
  return resolve(root, "ota-policy.json");
}

describe("installer OTA contracts", () => {
  it("persists and reloads the checksummed canonical root policy", async () => {
    const path = await target();
    await writeRootPolicy(policy, {
      path,
      uid: process.getuid(),
      gid: process.getgid(),
    });

    await expect(
      loadRootPolicy({ path, uid: process.getuid(), gid: process.getgid() }),
    ).resolves.toEqual(policy);
  });

  it("fails closed for absent, writable, or symlink policy files", async () => {
    const path = await target();
    await expect(
      loadRootPolicy({ path, uid: process.getuid(), gid: process.getgid() }),
    ).rejects.toThrow();

    await writeRootPolicy(policy, {
      path,
      uid: process.getuid(),
      gid: process.getgid(),
    });
    await chmod(path, 0o666);
    await expect(
      loadRootPolicy({ path, uid: process.getuid(), gid: process.getgid() }),
    ).rejects.toThrow();

    const link = `${path}.link`;
    await symlink(path, link);
    await expect(
      loadRootPolicy({
        path: link,
        uid: process.getuid(),
        gid: process.getgid(),
      }),
    ).rejects.toThrow();
  });

  it("distinguishes an absent operation journal from corrupt dual slots", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "ota-journal-"));
    roots.push(directory);
    await chmod(directory, 0o700);

    await expect(
      loadOperationJournal({ directory, uid: process.getuid() }),
    ).resolves.toBeNull();

    await writeFile(resolve(directory, "operation-a.json"), "{}", {
      mode: 0o600,
    });
    await writeFile(resolve(directory, "operation-b.json"), "{}", {
      mode: 0o600,
    });
    await expect(
      loadOperationJournal({ directory, uid: process.getuid() }),
    ).rejects.toThrow();
  });
});
