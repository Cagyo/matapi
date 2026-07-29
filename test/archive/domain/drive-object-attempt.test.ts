import { describe, expect, it } from "vitest";
import {
  DriveObjectAttempt,
  type VerifiedDriveObject,
} from "../../../src/archive/domain/drive-object-attempt.entity";
import { DriveObjectConflictError } from "../../../src/archive/domain/errors/drive-object-conflict.error";
import { DriveObjectDetachedError } from "../../../src/archive/domain/errors/drive-object-detached.error";

const fixtureAttempt = (remoteFileId: string) => ({
  id: "attempt-1",
  artifactId: "artifact-1",
  generationId: "generation-1",
  remoteFileId,
  parentId: "folder-1",
  nowMs: 1,
});

const verifiedObjectFixture = (): VerifiedDriveObject => ({
  id: "file-1",
  name: "clip.mp4",
  parentId: "folder-1",
  mimeType: "video/mp4",
  size: 42,
  sha256: "a".repeat(64),
  md5: "b".repeat(32),
  createdTimeMs: 1_787_900_000_000,
  headRevisionId: "revision-1",
  version: "1",
  ownedByMe: true,
  canDelete: true,
  trashed: false,
  appProperties: { a1v: "1" },
  sharing: {
    ownerPermissionId: "owner-1",
    shared: false,
    permissionIds: ["owner-1"],
  },
  webViewLink: "https://drive.example/file-1",
});

describe("DriveObjectAttempt", () => {
  it("never replaces an immutable reserved Drive ID", () => {
    const attempt = DriveObjectAttempt.reserve(fixtureAttempt("file-1"));

    expect(() => attempt.reserveRemoteId("file-2")).toThrow(
      DriveObjectConflictError,
    );
  });

  it("requires complete provider metadata before verification", () => {
    expect(() =>
      DriveObjectAttempt.reserve(fixtureAttempt("file-1")).verify({
        ...verifiedObjectFixture(),
        headRevisionId: null,
      } as unknown as VerifiedDriveObject),
    ).toThrow(DriveObjectConflictError);
  });

  it("rejects a non-canonical permission order before verification", () => {
    expect(() =>
      DriveObjectAttempt.reserve(fixtureAttempt("file-1")).verify({
        ...verifiedObjectFixture(),
        sharing: {
          ownerPermissionId: "owner-1",
          shared: true,
          permissionIds: ["viewer-1", "owner-1"],
        },
      }),
    ).toThrow(DriveObjectConflictError);
  });

  it("keeps a detached attempt terminal", () => {
    const detached = DriveObjectAttempt.reserve(
      fixtureAttempt("file-1"),
    ).detach("parent_changed");

    expect(() => detached.markRetryable()).toThrow(DriveObjectDetachedError);
  });
});
