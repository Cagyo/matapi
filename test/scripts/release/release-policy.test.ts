import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  computeCacheInventorySha256,
  evaluateReleasePolicy,
} from "../../../scripts/release/release-policy.mjs";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const cacheInventory = [
  {
    path: ".yarn/cache/a-package-npm-1.0.0.zip",
    size: 17,
    sha256: sha256("a"),
  },
  {
    path: ".yarn/cache/z-package-npm-2.0.0.zip",
    size: 23,
    sha256: sha256("z"),
  },
];

function validFacts() {
  const inventorySha256 = computeCacheInventorySha256(cacheInventory);

  return {
    request: {
      version: "1.2.3",
      commit: "a".repeat(40),
      target: "linux-arm64-glibc",
      tag: "v1.2.3",
    },
    checkout: {
      clean: true,
      headCommit: "a".repeat(40),
      tagKind: "tag",
      tagCommit: "a".repeat(40),
      commitEpoch: 1_725_000_000,
    },
    package: {
      version: "1.2.3",
      releaseTarget: "linux-arm64-glibc",
      packageManager: "yarn@4.13.0",
    },
    host: {
      platform: "linux",
      arch: "arm64",
      libc: "glibc",
      nodeMajor: 20,
      nodeModulesAbi: "115",
    },
    builder: {
      controlled: true,
      identity: "home-worker-linux-arm-builder-v1",
      target: "linux-arm64-glibc",
      nodeMajor: 20,
      nodeModulesAbi: "115",
    },
    environment: {
      tz: "UTC",
      locale: "C",
      sourceDateEpoch: 1_725_000_000,
    },
    cache: {
      validated: true,
      target: "linux-arm64-glibc",
      nodeMajor: 20,
      nodeModulesAbi: "115",
      yarnLockSha256: sha256("lock"),
      expectedYarnLockSha256: sha256("lock"),
      inventory: cacheInventory,
      inventorySha256,
    },
  };
}

describe("release candidate policy", () => {
  it("accepts only a fully attested Linux ARM Node 20 candidate", () => {
    expect(evaluateReleasePolicy(validFacts())).toEqual({
      publishable: true,
      label: "publishable",
      reasons: [],
    });
  });

  it("refuses the current Darwin/Node 24 class of host deterministically", () => {
    const facts = validFacts();
    facts.host = {
      platform: "darwin",
      arch: "arm64",
      libc: "unknown",
      nodeMajor: 24,
      nodeModulesAbi: "137",
    };

    expect(evaluateReleasePolicy(facts)).toEqual({
      publishable: false,
      label: "nonpublishable",
      reasons: [
        "host-libc",
        "host-node-abi",
        "host-node-major",
        "host-platform",
      ],
    });
  });

  it("requires an annotated version tag and exact checkout commit", () => {
    const facts = validFacts();
    facts.checkout.clean = false;
    facts.checkout.tagKind = "commit";
    facts.checkout.tagCommit = "b".repeat(40);

    expect(evaluateReleasePolicy(facts).reasons).toEqual([
      "checkout-dirty",
      "checkout-tag-commit",
      "checkout-tag-kind",
    ]);
  });

  it("requires package version and release target equality", () => {
    const facts = validFacts();
    facts.package.version = "1.2.4";
    facts.package.releaseTarget = "linux-armv7-glibc";

    expect(evaluateReleasePolicy(facts).reasons).toEqual([
      "package-target",
      "package-version",
    ]);
  });

  it("requires the pinned Node 20 module ABI across host, builder, and cache", () => {
    const facts = validFacts();
    facts.host.nodeModulesAbi = "999";
    facts.builder.nodeModulesAbi = "999";
    facts.cache.nodeModulesAbi = "999";

    expect(evaluateReleasePolicy(facts).reasons).toEqual([
      "builder-runtime",
      "cache-runtime",
      "host-node-abi",
    ]);
  });

  it("does not treat an arbitrary 32-bit ARM host as an ARMv7 builder", () => {
    const facts = validFacts();
    facts.request.target = "linux-armv7-glibc";
    facts.package.releaseTarget = "linux-armv7-glibc";
    facts.host.arch = "arm";
    facts.host.armVersion = 6;
    facts.builder.target = "linux-armv7-glibc";
    facts.cache.target = "linux-armv7-glibc";

    expect(evaluateReleasePolicy(facts).reasons).toEqual(["host-arm-version"]);
  });

  it("does not label a musl host as a glibc release target", () => {
    const facts = validFacts();
    facts.host.libc = "musl";

    expect(evaluateReleasePolicy(facts).reasons).toEqual(["host-libc"]);
  });

  it("canonicalizes cache inventory bytewise and detects mutations", () => {
    const reversed = [...cacheInventory].reverse();
    expect(computeCacheInventorySha256(reversed)).toBe(
      computeCacheInventorySha256(cacheInventory),
    );

    const facts = validFacts();
    facts.cache.inventory = [
      cacheInventory[0],
      { ...cacheInventory[1], size: cacheInventory[1].size + 1 },
    ];

    expect(evaluateReleasePolicy(facts).reasons).toEqual(["cache-inventory"]);
  });

  it("rejects malformed cache inventory records", () => {
    expect(() =>
      computeCacheInventorySha256([
        { path: "../escape.zip", size: 1, sha256: "0".repeat(64) },
      ]),
    ).toThrow(/cache inventory/i);
  });

  it("rejects inherited object keys as unsupported targets", () => {
    const facts = validFacts();
    facts.request.target = "__proto__";
    facts.package.releaseTarget = "__proto__";
    facts.builder.target = "__proto__";
    facts.cache.target = "__proto__";

    expect(evaluateReleasePolicy(facts).reasons).toContain("request-target");
  });
});
