import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { runCandidateBuild } from "../../../scripts/release/candidate-orchestrator.mjs";
import { computeCacheInventorySha256 } from "../../../scripts/release/release-policy.mjs";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const policy = {
  schemaVersion: 1,
  identity: "home-worker-linux-arm-builder-v1",
  target: {
    targetName: "linux-arm64-glibc",
    platform: "linux",
    arch: "arm64",
    libc: "glibc",
    libcVersion: "2.36",
    nodeModulesAbi: "115",
  },
  runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
};

const inventory = [
  {
    path: "dist/main.js",
    type: "file",
    mode: 0o644,
    uid: 0,
    gid: 0,
    mtime: 1_725_000_000,
    size: 11,
    sha256: digest("main"),
  },
];
const cacheInventory = [
  { path: ".yarn/cache/a.zip", size: 7, sha256: digest("cache") },
];
const cacheInventorySha256 = computeCacheInventorySha256(cacheInventory);

function input(run = "a") {
  return {
    version: "1.2.3",
    commit: "a".repeat(40),
    tag: "v1.2.3",
    target: "linux-arm64-glibc",
    sourceDateEpoch: 1_725_000_000,
    sourceRoot: "/source",
    workRoot: `/work/${run}`,
    outputRoot: `/output/${run}`,
    builderPolicy: policy,
  };
}

function dependencies(failPhase?: string) {
  const calls: string[] = [];
  const record = async (phase: string) => {
    calls.push(phase);
    if (phase === failPhase) throw new Error(`failed ${phase}`);
  };
  const deps = {
    resolveBuildRoots: vi.fn(
      async (roots: {
        sourceRoot: string;
        workRoot: string;
        outputRoot: string;
      }) => {
        await record("resolve-build-roots");
        return { ...roots, rootGuard: { fixture: true } };
      },
    ),
    prepareBuildCheckout: vi.fn(async () => record("prepare-build-checkout")),
    prepareAssembly: vi.fn(async () => record("prepare-assembly")),
    removeProductionProjection: vi.fn(async () =>
      record("remove-production-projection"),
    ),
    sealReleaseConfig: vi.fn(async () => record("seal-release-config")),
    prepareValidationCopy: vi.fn(async () => record("prepare-validation-copy")),
    run: vi.fn(async ({ phase }: { phase: string }) => record(phase)),
    inspectCache: vi
      .fn()
      .mockImplementationOnce(async () => {
        await record("inspect-cache-before");
        return { inventory: cacheInventory, sha256: cacheInventorySha256 };
      })
      .mockImplementationOnce(async () => {
        await record("inspect-cache-after");
        return { inventory: cacheInventory, sha256: cacheInventorySha256 };
      }),
    createArchive: vi.fn(async () => {
      await record("create-archive");
      return { bytes: Buffer.from("archive"), inventory };
    }),
    publish: vi.fn(async ({ descriptorBytes }: { descriptorBytes: Buffer }) => {
      await record("publish");
      return { descriptorBytes };
    }),
  };
  return { deps, calls };
}

describe("candidate build orchestration", () => {
  it("keeps source, assembly, validation, and output roots separate and ordered", async () => {
    const { deps, calls } = dependencies();

    const result = await runCandidateBuild(input(), deps);

    expect(calls).toEqual([
      "resolve-build-roots",
      "prepare-build-checkout",
      "install-development",
      "test",
      "build",
      "prepare-assembly",
      "pin-yarn",
      "focus-production-online",
      "remove-production-projection",
      "seal-release-config",
      "inspect-cache-before",
      "prepare-validation-copy",
      "focus-production-offline",
      "inspect-cache-after",
      "create-archive",
      "publish",
    ]);
    expect(deps.prepareBuildCheckout).toHaveBeenCalledWith({
      sourceRoot: "/source",
      buildRoot: "/work/a/build",
      commit: "a".repeat(40),
      tag: "v1.2.3",
    });
    expect(deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({ rootGuard: { fixture: true } }),
    );
    expect(deps.prepareAssembly).toHaveBeenCalledWith({
      buildRoot: "/work/a/build",
      assemblyRoot: "/work/a/assembly",
    });
    expect(deps.prepareValidationCopy).toHaveBeenCalledWith({
      assemblyRoot: "/work/a/assembly",
      validationRoot: "/work/a/validation",
    });
    expect(result.descriptorBytes.toString("utf8")).toContain(
      '"kind":"home-worker-unsigned-candidate"',
    );
  });

  it.each([
    "install-development",
    "test",
    "build",
    "pin-yarn",
    "focus-production-online",
    "inspect-cache-before",
    "focus-production-offline",
    "inspect-cache-after",
    "create-archive",
  ])("emits no output when %s fails", async (phase) => {
    const { deps } = dependencies(phase);
    await expect(runCandidateBuild(input(), deps)).rejects.toThrow(
      `failed ${phase}`,
    );
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("rejects overlapping roots before running commands", async () => {
    const { deps } = dependencies();
    await expect(
      runCandidateBuild(
        { ...input(), workRoot: "/source/work", outputRoot: "/output" },
        deps,
      ),
    ).rejects.toThrow(/separate/i);
    expect(deps.resolveBuildRoots).not.toHaveBeenCalled();
    expect(deps.prepareBuildCheckout).not.toHaveBeenCalled();
  });

  it("rejects cache mutation before archiving", async () => {
    const { deps } = dependencies();
    deps.inspectCache.mockReset();
    const mutated = [
      { path: ".yarn/cache/a.zip", size: 8, sha256: digest("changed") },
    ];
    deps.inspectCache
      .mockResolvedValueOnce({
        inventory: cacheInventory,
        sha256: cacheInventorySha256,
      })
      .mockResolvedValueOnce({
        inventory: mutated,
        sha256: computeCacheInventorySha256(mutated),
      });

    await expect(runCandidateBuild(input(), deps)).rejects.toThrow(
      /cache mutation/i,
    );
    expect(deps.createArchive).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("produces byte-identical descriptors for independent run roots", async () => {
    const first = dependencies();
    const second = dependencies();
    const firstResult = await runCandidateBuild(input("a"), first.deps);
    const secondResult = await runCandidateBuild(input("b"), second.deps);

    expect(firstResult.descriptorBytes).toEqual(secondResult.descriptorBytes);
  });
});
