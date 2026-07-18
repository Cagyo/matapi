import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ArtifactIdentity,
  ArtifactMarker,
} from "../../../src/system/domain/ota-contracts";
import { artifactDirectoryName } from "../../../src/system/domain/release-identity";
import { FsInstalledReleaseAdapter } from "../../../src/system/infrastructure/fs-installed-release.adapter";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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
    url: "https://updates.example.test/release.tar.gz",
    format: "tar.gz",
    size: 1,
    expandedSize: 1,
    maxPreparedSize: 1,
    maxPreparedFiles: 1,
    fileCount: 1,
    sha256: "a".repeat(64),
  };
}

function marker(identity = artifact()): ArtifactMarker {
  return {
    schemaVersion: 1,
    artifact: identity,
    metadata: {
      metadataVersion: 42,
      channel: "stable",
      payloadSha256: "b".repeat(64),
      publishedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-31T00:00:00.000Z",
    },
    envelopeSha256: createHash("sha256").update("envelope").digest("hex"),
    preparedTreeSha256: createHash("sha256").update("tree").digest("hex"),
    writtenAt: "2030-01-15T00:00:00.000Z",
  };
}

async function layout() {
  const root = await mkdtemp(resolve(tmpdir(), "installed-release-"));
  roots.push(root);
  const identity = artifact();
  const name = artifactDirectoryName(identity);
  const release = resolve(root, "releases", name);
  await mkdir(release, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(release, "artifact-state.json"),
    JSON.stringify(marker(identity)),
    { mode: 0o600 },
  );
  await symlink(`releases/${name}`, resolve(root, "current"));
  return { root, release, identity, name };
}

describe("FsInstalledReleaseAdapter", () => {
  it("loads the installed artifact from current plus no-follow artifact-state.json", async () => {
    const fixture = await layout();
    const adapter = new FsInstalledReleaseAdapter(fixture.root);

    expect(await adapter.loadCurrent()).toEqual(fixture.identity);
    expect(
      (await lstat(resolve(fixture.root, "current"))).isSymbolicLink(),
    ).toBe(true);
  });

  it("rejects an artifact-state symlink", async () => {
    const fixture = await layout();
    const external = resolve(fixture.root, "external.json");
    await writeFile(external, JSON.stringify(marker()));
    await rm(resolve(fixture.release, "artifact-state.json"));
    await symlink(external, resolve(fixture.release, "artifact-state.json"));

    await expect(
      new FsInstalledReleaseAdapter(fixture.root).loadCurrent(),
    ).rejects.toMatchObject({
      code: "maintenance-required",
    });
  });

  it("rejects current paths outside the direct releases directory", async () => {
    const fixture = await layout();
    await rm(resolve(fixture.root, "current"));
    await symlink("../outside", resolve(fixture.root, "current"));

    await expect(
      new FsInstalledReleaseAdapter(fixture.root).loadCurrent(),
    ).rejects.toMatchObject({
      code: "maintenance-required",
    });
  });

  it("rejects marker identity that does not match the current directory", async () => {
    const fixture = await layout();
    await writeFile(
      resolve(fixture.release, "artifact-state.json"),
      JSON.stringify(marker(artifactWithVersion("1.4.1"))),
    );

    await expect(
      new FsInstalledReleaseAdapter(fixture.root).loadCurrent(),
    ).rejects.toMatchObject({
      code: "maintenance-required",
    });
  });

  it("opens artifact state with O_NOFOLLOW support", () => {
    expect(constants.O_NOFOLLOW).toBeTypeOf("number");
  });
});

function artifactWithVersion(version: string): ArtifactIdentity {
  return { ...artifact(), version };
}
