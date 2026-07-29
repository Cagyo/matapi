import {
  requirePrivateOwnedDriveObjectMetadata,
  type VerifiedDriveObject,
  type VerifiedDriveObjectMetadata,
} from "./drive-object-metadata.value-object";
import { DriveObjectConflictError } from "./errors/drive-object-conflict.error";
import { DriveObjectDetachedError } from "./errors/drive-object-detached.error";

export type {
  CanonicalSharingState,
  VerifiedDriveObject,
} from "./drive-object-metadata.value-object";

export type DriveAttemptState =
  | "pending"
  | "uploading"
  | "retryable"
  | "verified"
  | "missing"
  | "detached"
  | "conflict"
  | "abandoned"
  | "deleted";

export interface ReserveDriveObjectAttempt {
  id: string;
  artifactId: string;
  generationId: string;
  remoteFileId: string;
  parentId: string;
  nowMs: number;
}

export interface DriveObjectAttemptSnapshot extends ReserveDriveObjectAttempt {
  state: DriveAttemptState;
  verifiedMetadata: VerifiedDriveObjectMetadata | null;
  detachedReason: string | null;
  missingReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  uploadedAtMs: number | null;
  verifiedAtMs: number | null;
  deletedAtMs: number | null;
  revision: number;
}

export class DriveObjectAttempt implements DriveObjectAttemptSnapshot {
  readonly id!: string;
  readonly artifactId!: string;
  readonly generationId!: string;
  readonly remoteFileId!: string;
  readonly parentId!: string;
  readonly nowMs!: number;
  readonly state!: DriveAttemptState;
  readonly verifiedMetadata!: VerifiedDriveObjectMetadata | null;
  readonly detachedReason!: string | null;
  readonly missingReason!: string | null;
  readonly createdAtMs!: number;
  readonly updatedAtMs!: number;
  readonly uploadedAtMs!: number | null;
  readonly verifiedAtMs!: number | null;
  readonly deletedAtMs!: number | null;
  readonly revision!: number;

  private constructor(snapshot: DriveObjectAttemptSnapshot) {
    Object.assign(this, normalizeAttemptSnapshot(snapshot));
    Object.freeze(this);
  }

  static reserve(input: ReserveDriveObjectAttempt): DriveObjectAttempt {
    return new DriveObjectAttempt({
      ...input,
      state: "pending",
      verifiedMetadata: null,
      detachedReason: null,
      missingReason: null,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
      uploadedAtMs: null,
      verifiedAtMs: null,
      deletedAtMs: null,
      revision: 0,
    });
  }

  static restore(snapshot: DriveObjectAttemptSnapshot): DriveObjectAttempt {
    return new DriveObjectAttempt(snapshot);
  }

  reserveRemoteId(remoteFileId: string): DriveObjectAttempt {
    requireText(remoteFileId, "Reserved Drive ID");
    if (remoteFileId !== this.remoteFileId) {
      throw new DriveObjectConflictError("Reserved Drive ID is immutable");
    }
    return this;
  }

  markUploading(nowMs = this.updatedAtMs): DriveObjectAttempt {
    return this.transition("uploading", nowMs, { uploadedAtMs: nowMs });
  }

  markRetryable(nowMs = this.updatedAtMs): DriveObjectAttempt {
    return this.transition("retryable", nowMs);
  }

  verify(
    remote: VerifiedDriveObject,
    nowMs = this.updatedAtMs,
  ): DriveObjectAttempt {
    const metadata = requirePrivateOwnedDriveObjectMetadata(remote);
    if (
      metadata.id !== this.remoteFileId ||
      metadata.parentId !== this.parentId
    ) {
      throw new DriveObjectConflictError(
        "Drive verification does not match the reserved object",
      );
    }
    if (this.verifiedMetadata !== null) {
      if (!sameVerifiedMetadata(this.verifiedMetadata, metadata)) {
        throw new DriveObjectConflictError(
          "Verified Drive metadata is immutable",
        );
      }
      return this;
    }
    return this.transition("verified", nowMs, {
      verifiedMetadata: metadata,
      verifiedAtMs: nowMs,
    });
  }

  markMissing(
    reason = "remote_missing",
    nowMs = this.updatedAtMs,
  ): DriveObjectAttempt {
    requireText(reason, "Missing reason");
    return this.transition("missing", nowMs, { missingReason: reason });
  }

  detach(reason: string, nowMs = this.updatedAtMs): DriveObjectAttempt {
    requireText(reason, "Detach reason");
    if (this.state === "detached") return this;
    return this.transition("detached", nowMs, { detachedReason: reason });
  }

  markConflict(nowMs = this.updatedAtMs): DriveObjectAttempt {
    return this.transition("conflict", nowMs);
  }

  abandon(nowMs = this.updatedAtMs): DriveObjectAttempt {
    return this.transition("abandoned", nowMs);
  }

  markDeleted(nowMs = this.updatedAtMs): DriveObjectAttempt {
    return this.transition("deleted", nowMs, { deletedAtMs: nowMs });
  }

  private transition(
    state: DriveAttemptState,
    nowMs: number,
    update: Partial<
      Pick<
        DriveObjectAttemptSnapshot,
        | "verifiedMetadata"
        | "detachedReason"
        | "missingReason"
        | "uploadedAtMs"
        | "verifiedAtMs"
        | "deletedAtMs"
      >
    > = {},
  ): DriveObjectAttempt {
    if (this.state === "detached") {
      throw new DriveObjectDetachedError();
    }
    if (this.state === state) return this;
    const legal: Record<DriveAttemptState, readonly DriveAttemptState[]> = {
      pending: [
        "uploading",
        "retryable",
        "verified",
        "missing",
        "detached",
        "conflict",
        "abandoned",
      ],
      uploading: [
        "retryable",
        "verified",
        "missing",
        "detached",
        "conflict",
        "abandoned",
      ],
      retryable: [
        "uploading",
        "verified",
        "missing",
        "detached",
        "conflict",
        "abandoned",
      ],
      verified: ["missing", "detached", "deleted"],
      missing: ["detached", "abandoned"],
      detached: [],
      conflict: ["detached", "abandoned"],
      abandoned: [],
      deleted: [],
    };
    if (!legal[this.state].includes(state)) {
      throw new DriveObjectConflictError(
        `Drive attempt cannot transition from ${this.state} to ${state}`,
      );
    }
    return new DriveObjectAttempt({
      ...this,
      ...update,
      state,
      updatedAtMs: nowMs,
      revision: this.revision + 1,
    });
  }
}

function normalizeAttemptSnapshot(
  snapshot: DriveObjectAttemptSnapshot,
): DriveObjectAttemptSnapshot {
  requireText(snapshot.id, "Drive attempt ID");
  requireText(snapshot.artifactId, "Archive artifact ID");
  requireText(snapshot.generationId, "Drive generation ID");
  requireText(snapshot.remoteFileId, "Reserved Drive ID");
  requireText(snapshot.parentId, "Expected Drive parent ID");
  requireNonNegativeInteger(snapshot.nowMs, "Drive attempt reservation time");
  if (!isAttemptState(snapshot.state)) {
    throw new DriveObjectConflictError("Drive attempt state is malformed");
  }
  requireNonNegativeInteger(
    snapshot.createdAtMs,
    "Drive attempt creation time",
  );
  requireNonNegativeInteger(snapshot.updatedAtMs, "Drive attempt update time");
  requireNonNegativeInteger(snapshot.revision, "Drive attempt revision");
  for (const [label, value] of [
    ["Drive upload time", snapshot.uploadedAtMs],
    ["Drive verification time", snapshot.verifiedAtMs],
    ["Drive deletion time", snapshot.deletedAtMs],
  ] as const) {
    if (value !== null) requireNonNegativeInteger(value, label);
  }
  const verifiedMetadata =
    snapshot.verifiedMetadata === null
      ? null
      : requirePrivateOwnedDriveObjectMetadata(snapshot.verifiedMetadata);
  if (verifiedMetadata !== null) {
    if (
      verifiedMetadata.id !== snapshot.remoteFileId ||
      verifiedMetadata.parentId !== snapshot.parentId ||
      snapshot.verifiedAtMs === null
    ) {
      throw new DriveObjectConflictError(
        "Verified Drive metadata is inconsistent",
      );
    }
  }
  if (snapshot.state === "verified" && verifiedMetadata === null) {
    throw new DriveObjectConflictError(
      "Verified Drive attempt lacks verified metadata",
    );
  }
  if (snapshot.state === "detached")
    requireText(snapshot.detachedReason, "Detach reason");
  if (snapshot.state === "missing")
    requireText(snapshot.missingReason, "Missing reason");
  return {
    ...snapshot,
    verifiedMetadata,
  };
}

function sameVerifiedMetadata(
  first: VerifiedDriveObjectMetadata,
  second: VerifiedDriveObjectMetadata,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function isAttemptState(value: unknown): value is DriveAttemptState {
  return (
    value === "pending" ||
    value === "uploading" ||
    value === "retryable" ||
    value === "verified" ||
    value === "missing" ||
    value === "detached" ||
    value === "conflict" ||
    value === "abandoned" ||
    value === "deleted"
  );
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value) {
    throw new DriveObjectConflictError(`${label} is missing`);
  }
}

function requireNonNegativeInteger(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DriveObjectConflictError(`${label} is malformed`);
  }
}
