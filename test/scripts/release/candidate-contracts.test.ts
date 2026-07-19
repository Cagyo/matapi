import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  encodeCandidateDescriptor,
  measureCandidateArchive,
} from "../../../scripts/release/candidate-descriptor.mjs";
import {
  encodeBuilderPolicy,
  parseBuilderPolicy,
  validateBuilderPolicyOwnership,
} from "../../../scripts/release/builder-policy.mjs";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function builderPolicy() {
  return {
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
}

const inventory = [
  {
    path: "dist",
    type: "directory",
    mode: 0o755,
    uid: 0,
    gid: 0,
    mtime: 1_725_000_000,
    size: 0,
    sha256: null,
  },
  {
    path: "dist/main.js",
    type: "file",
    mode: 0o644,
    uid: 0,
    gid: 0,
    mtime: 1_725_000_000,
    size: 11,
    sha256: sha256("main"),
  },
  {
    path: "scripts/update.sh",
    type: "file",
    mode: 0o755,
    uid: 0,
    gid: 0,
    mtime: 1_725_000_000,
    size: 17,
    sha256: sha256("update"),
  },
];

describe("static release builder policy", () => {
  it("accepts only a root-owned, non-writable regular policy file", () => {
    expect(() => {
      validateBuilderPolicyOwnership({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 0n,
        mode: 0o100644n,
      });
    }).not.toThrow();
    expect(() => {
      validateBuilderPolicyOwnership({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 1000n,
        mode: 0o100644n,
      });
    }).toThrow(/root-owned/i);
    expect(() => {
      validateBuilderPolicyOwnership({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 0n,
        mode: 0o100664n,
      });
    }).toThrow(/writable/i);
  });

  it("round-trips one canonical root-provisioned ARM64 policy", () => {
    const encoded = encodeBuilderPolicy(builderPolicy());
    expect(encoded.toString("utf8")).toBe(
      `${JSON.stringify(builderPolicy())}\n`,
    );
    expect(parseBuilderPolicy(encoded)).toEqual(builderPolicy());
  });

  it.each([
    [
      "ARMv7",
      {
        ...builderPolicy(),
        target: {
          ...builderPolicy().target,
          targetName: "linux-armv7-glibc",
          arch: "arm",
        },
      },
    ],
    [
      "wrong ABI",
      {
        ...builderPolicy(),
        target: { ...builderPolicy().target, nodeModulesAbi: "999" },
      },
    ],
    [
      "wrong runtime",
      {
        ...builderPolicy(),
        runtime: { ...builderPolicy().runtime, nodeMajor: 24 },
      },
    ],
    ["unknown key", { ...builderPolicy(), extra: true }],
  ])("rejects %s policy", (_label, value) => {
    expect(() => {
      parseBuilderPolicy(Buffer.from(`${JSON.stringify(value)}\n`));
    }).toThrow(/builder policy/i);
  });

  it("rejects noncanonical or duplicate-key policy bytes", () => {
    const canonical = JSON.stringify(builderPolicy());
    expect(() => {
      parseBuilderPolicy(Buffer.from(` ${canonical}\n`));
    }).toThrow(/canonical/i);
    expect(() => {
      parseBuilderPolicy(
        Buffer.from(
          canonical.replace(
            '"schemaVersion":1',
            '"schemaVersion":1,"schemaVersion":1',
          ) + "\n",
        ),
      );
    }).toThrow(/canonical/i);
  });
});

describe("unsigned candidate descriptor", () => {
  it("derives bounded regular-file metrics and a canonical descriptor", () => {
    const archiveBytes = Buffer.from("deterministic archive bytes");
    const archive = measureCandidateArchive({
      archiveBytes,
      inventory,
      sourceDateEpoch: 1_725_000_000,
    });

    expect(archive).toEqual({
      format: "tar.gz",
      size: archiveBytes.length,
      expandedSize: 28,
      maxPreparedSize: 1024 * 1024 * 1024,
      maxPreparedFiles: 200_000,
      fileCount: 3,
      sha256: sha256("deterministic archive bytes"),
      inventorySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const descriptor = encodeCandidateDescriptor({
      version: "1.2.3",
      commit: "a".repeat(40),
      sourceDateEpoch: 1_725_000_000,
      builderPolicy: builderPolicy(),
      cacheInventorySha256: sha256("cache inventory"),
      archive,
    });
    const parsed = JSON.parse(descriptor.toString("utf8"));
    expect(descriptor.at(-1)).toBe(0x0a);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: "home-worker-unsigned-candidate",
      channel: "stable",
      version: "1.2.3",
      commit: "a".repeat(40),
      target: builderPolicy().target,
      artifact: archive,
      runtime: builderPolicy().runtime,
      provenance: {
        sourceDateEpoch: 1_725_000_000,
        cacheInventorySha256: sha256("cache inventory"),
      },
    });
    expect(descriptor.toString("utf8")).toBe(`${JSON.stringify(parsed)}\n`);
  });

  it("rejects archive limit violations and inconsistent inventory", () => {
    expect(() => {
      measureCandidateArchive({
        archiveBytes: Buffer.alloc(100 * 1024 * 1024 + 1),
        inventory,
        sourceDateEpoch: 1_725_000_000,
      });
    }).toThrow(/artifact size/i);
    expect(() => {
      measureCandidateArchive({
        archiveBytes: Buffer.from("x"),
        inventory: [{ ...inventory[1], size: 512 * 1024 * 1024 + 1 }],
        sourceDateEpoch: 1_725_000_000,
      });
    }).toThrow(/expanded size/i);
    expect(() => {
      measureCandidateArchive({
        archiveBytes: Buffer.from("x"),
        inventory: [inventory[1], { ...inventory[1] }],
        sourceDateEpoch: 1_725_000_000,
      });
    }).toThrow(/inventory/i);
  });
});
