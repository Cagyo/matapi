import { describe, expect, it } from "vitest";
import {
  ArchiveArtifact,
  canonicalSourceFingerprintInput,
  type RegisterArchiveArtifact,
} from "../../../src/archive/domain/archive-artifact.entity";
import { DriveObjectConflictError } from "../../../src/archive/domain/errors/drive-object-conflict.error";

const fixture = (): RegisterArchiveArtifact => ({
  installationId: "installation-1",
  kind: "motion_video",
  sourceIdentity: "motion-hook:17",
  trustedPath: "/srv/motion/2026/07/29/clip.mp4",
  relativePath: "2026/07/29/clip.mp4",
  size: 42,
  mtimeNs: "1787900000000000000",
  sourceTimeMs: 1_787_900_000_000,
  sha256: "a".repeat(64),
  sourceFingerprint: "b".repeat(64),
});

describe("ArchiveArtifact", () => {
  it("keeps the local identity immutable after registration", () => {
    const artifact = ArchiveArtifact.register(fixture(), {
      id: "artifact-1",
      nowMs: 1,
    });

    expect(() => artifact.withTrustedPath("/srv/motion/other.mp4")).toThrow(
      DriveObjectConflictError,
    );
  });

  it("uses unambiguous length-prefixed fields for source fingerprints", () => {
    const base = fixture();
    const first = canonicalSourceFingerprintInput({
      ...base,
      relativePath: "ab",
      sha256: "c",
    });
    const second = canonicalSourceFingerprintInput({
      ...base,
      relativePath: "a",
      sha256: "bc",
    });

    expect(first).toContain("\0");
    expect(first).not.toBe(second);
  });
});
