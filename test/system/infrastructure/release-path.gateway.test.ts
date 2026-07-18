import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { artifactDirectoryName } from "../../../src/system/domain/release-identity";
import type { ArtifactIdentity } from "../../../src/system/domain/ota-contracts";
import { ReleasePathGateway } from "../../../src/system/infrastructure/release-path.gateway";

const roots: string[] = [];
const VALID_NAME = `1.4.2-${"a".repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(resolve(tmpdir(), "release-path-"));
  chmodSync(root, 0o755);
  roots.push(root);
  return root;
}

function artifact(): ArtifactIdentity {
  return {
    version: "1.4.2",
    commit: "0123456789abcdef0123456789abcdef01234567",
    targetName: "linux-armv7-glibc",
    target: {
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcMinVersion: "2.28",
      nodeModulesAbi: "115",
    },
    url: "https://updates.example.test/home-worker-1.4.2.tar.gz",
    format: "tar.gz",
    size: 10,
    expandedSize: 20,
    maxPreparedSize: 30,
    maxPreparedFiles: 40,
    fileCount: 2,
    sha256: "a".repeat(64),
  };
}

describe("ReleasePathGateway", () => {
  it("resolves the canonical artifact-derived direct child", async () => {
    const root = directory();
    const name = artifactDirectoryName(artifact());
    mkdirSync(resolve(root, name), { mode: 0o755 });

    await expect(new ReleasePathGateway(root).resolveChild(name)).resolves.toBe(
      resolve(root, name),
    );
  });

  it.each([
    "../shared",
    "/etc",
    "1.4.2-aaaa",
    `1.4.2-${"a".repeat(63)}`,
    `x/1.4.2-${"a".repeat(64)}`,
    `shared/1.4.2-${"a".repeat(64)}`,
  ])("rejects journal target %s", async (name) => {
    await expect(
      new ReleasePathGateway(directory()).resolveChild(name),
    ).rejects.toThrow();
  });

  it("rejects a symlink child even when its basename is canonical", async () => {
    const root = directory();
    const outside = directory();
    symlinkSync(outside, resolve(root, VALID_NAME), "dir");

    await expect(
      new ReleasePathGateway(root).resolveChild(VALID_NAME),
    ).rejects.toThrow(/symlink|directory/i);
  });

  it("rejects a child with the wrong mode", async () => {
    const root = directory();
    mkdirSync(resolve(root, VALID_NAME), { mode: 0o700 });

    await expect(
      new ReleasePathGateway(root).resolveChild(VALID_NAME),
    ).rejects.toThrow(/mode|0755/i);
  });

  it("rejects a child not owned by the configured service uid", async () => {
    const root = directory();
    mkdirSync(resolve(root, VALID_NAME), { mode: 0o755 });
    const actualUid = process.getuid?.() ?? 0;

    await expect(
      new ReleasePathGateway(root, actualUid + 1).resolveChild(VALID_NAME),
    ).rejects.toThrow(/owner/i);
  });

  it("rejects a symlink release root", async () => {
    const parent = directory();
    const target = directory();
    const linked = resolve(parent, "releases");
    symlinkSync(target, linked, "dir");
    mkdirSync(resolve(target, VALID_NAME), { mode: 0o755 });

    await expect(
      new ReleasePathGateway(linked).resolveChild(VALID_NAME),
    ).rejects.toThrow(/root|symlink|directory/i);
  });
});
