import { describe, expect, it } from "vitest";
import {
  artifactDirectoryName,
  parseReleaseName,
  sameCheckedRelease,
} from "../../../src/system/domain/release-identity";
import vectors from "../../fixtures/ota/contracts/schema-v1-vectors.json";
import type { CheckedReleaseIdentity } from "../../../src/system/domain/ota-contracts";

const checked: CheckedReleaseIdentity = {
  artifact: {
    version: "1.4.2",
    commit: "0123456789abcdef0123456789abcdef01234567",
    targetName: "linux-arm",
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
  },
  metadata: {
    metadataVersion: 42,
    channel: "stable",
    payloadSha256: "b".repeat(64),
    publishedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-02T00:00:00.000Z",
  },
};

describe("release identity", () => {
  it("uses the complete artifact digest in the release directory", () => {
    expect(artifactDirectoryName(checked.artifact)).toBe(
      `1.4.2-${"a".repeat(64)}`,
    );
  });

  it("distinguishes a metadata refresh from the displayed authorization", () => {
    expect(
      sameCheckedRelease(checked, {
        ...checked,
        metadata: { ...checked.metadata, metadataVersion: 43 },
      }),
    ).toBe(false);
  });

  it("accepts only canonical release names", () => {
    expect(parseReleaseName(`1.4.2-${"a".repeat(64)}`)).toEqual({
      version: "1.4.2",
      artifactSha256: "a".repeat(64),
    });
    expect(() => parseReleaseName(`v1.4.2-${"a".repeat(64)}`)).toThrow();
    expect(() => parseReleaseName(`1.4.2-${"A".repeat(64)}`)).toThrow();
    expect(() => parseReleaseName(`1.4.2-rc.1-${"a".repeat(64)}`)).toThrow();
    expect(() => parseReleaseName(`01.4.2-${"a".repeat(64)}`)).toThrow();
  });

  it("matches the portable stable-feed release-name vectors", () => {
    expect(parseReleaseName(vectors.releaseNames.valid)).toEqual({
      version: "1.4.2",
      artifactSha256: "a".repeat(64),
    });
    for (const invalid of vectors.releaseNames.invalid) {
      expect(() => parseReleaseName(invalid)).toThrow();
    }
  });
});
