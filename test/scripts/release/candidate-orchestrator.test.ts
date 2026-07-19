import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runCandidateBuild } from "../../../scripts/release/candidate-orchestrator.mjs";

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
    path: ".yarn/releases/yarn-4.13.0.cjs",
    type: "file",
    mode: 0o644,
    uid: 0,
    gid: 0,
    mtime: 1_725_000_000,
    size: 11,
    sha256: digest("yarn"),
  },
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
  {
    path: "yarn.lock",
    type: "file",
    mode: 0o644,
    uid: 0,
    gid: 0,
    mtime: 1_725_000_000,
    size: 11,
    sha256: digest("lock"),
  },
];
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
    sealReleaseConfig: vi.fn(async () => record("seal-release-config")),
    run: vi.fn(async ({ phase }: { phase: string }) => record(phase)),
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
  it("builds and archives a dependency-free candidate in order", async () => {
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
      "seal-release-config",
      "create-archive",
      "publish",
    ]);
    expect(deps.prepareBuildCheckout).toHaveBeenCalledWith({
      sourceRoot: "/source",
      buildRoot: "/work/a/build",
      commit: "a".repeat(40),
      tag: "v1.2.3",
    });
    expect(deps.run).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: `${dirname(process.execPath)}/corepack`,
        env: expect.objectContaining({
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        }),
      }),
    );
    expect(deps.publish).toHaveBeenCalledWith(
      expect.objectContaining({ rootGuard: { fixture: true } }),
    );
    expect(deps.prepareAssembly).toHaveBeenCalledWith({
      buildRoot: "/work/a/build",
      assemblyRoot: "/work/a/assembly",
    });
    expect(deps.createArchive).toHaveBeenCalledWith({
      assemblyRoot: "/work/a/assembly",
      sourceDateEpoch: 1_725_000_000,
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
    "create-archive",
  ])("emits no output when %s fails", async (phase) => {
    const { deps } = dependencies(phase);
    await expect(runCandidateBuild(input(), deps)).rejects.toMatchObject({
      stage: phase,
      code: "operation-failed",
    });
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("classifies canonical root resolution failures before work creation", async () => {
    const { deps } = dependencies();
    deps.resolveBuildRoots.mockRejectedValueOnce(
      new Error("secret path /builder/private"),
    );

    await expect(runCandidateBuild(input(), deps)).rejects.toMatchObject({
      stage: "resolve-build-roots",
      code: "operation-failed",
    });
    expect(deps.prepareBuildCheckout).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("rejects overlapping roots before running commands", async () => {
    const { deps } = dependencies();
    await expect(
      runCandidateBuild(
        { ...input(), workRoot: "/source/work", outputRoot: "/output" },
        deps,
      ),
    ).rejects.toMatchObject({
      stage: "resolve-build-roots",
      code: "root-overlap",
    });
    expect(deps.resolveBuildRoots).not.toHaveBeenCalled();
    expect(deps.prepareBuildCheckout).not.toHaveBeenCalled();
  });

  it("produces byte-identical descriptors for independent run roots", async () => {
    const first = dependencies();
    const second = dependencies();
    const firstResult = await runCandidateBuild(input("a"), first.deps);
    const secondResult = await runCandidateBuild(input("b"), second.deps);

    expect(firstResult.descriptorBytes).toEqual(secondResult.descriptorBytes);
  });
});
