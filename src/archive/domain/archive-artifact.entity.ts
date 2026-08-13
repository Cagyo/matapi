import { DriveObjectConflictError } from "./errors/drive-object-conflict.error";

export type ArchiveArtifactKind = "motion_video" | "database_backup";
export type ArchiveArtifactState =
  | "stabilizing"
  | "pending"
  | "verified"
  | "local_missing"
  | "superseded";

export interface RegisterArchiveArtifact {
  installationId: string;
  kind: ArchiveArtifactKind;
  sourceIdentity: string;
  trustedPath: string;
  relativePath: string;
  size: number;
  mtimeNs: string;
  sourceTimeMs: number;
  sha256: string;
  sourceFingerprint: string;
}

export interface ArchiveArtifactSnapshot extends RegisterArchiveArtifact {
  id: string;
  state: ArchiveArtifactState;
  currentVerifiedAttemptId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  localDeletedAtMs: number | null;
  revision: number;
  admission: {
    state: 'ready';
    motionDayPath: string | null;
    nextAttemptMs: number;
    errorCode: string | null;
    revision: number;
  };
}

type ArchiveArtifactRestoreSnapshot = Omit<ArchiveArtifactSnapshot, 'admission'> & {
  admission?: ArchiveArtifactSnapshot['admission'];
};

export class ArchiveArtifact implements ArchiveArtifactSnapshot {
  readonly id!: string;
  readonly installationId!: string;
  readonly kind!: ArchiveArtifactKind;
  readonly sourceIdentity!: string;
  readonly trustedPath!: string;
  readonly relativePath!: string;
  readonly size!: number;
  readonly mtimeNs!: string;
  readonly sourceTimeMs!: number;
  readonly sha256!: string;
  readonly sourceFingerprint!: string;
  readonly state!: ArchiveArtifactState;
  readonly currentVerifiedAttemptId!: string | null;
  readonly createdAtMs!: number;
  readonly updatedAtMs!: number;
  readonly localDeletedAtMs!: number | null;
  readonly revision!: number;
  readonly admission!: ArchiveArtifactSnapshot['admission'];

  private constructor(snapshot: ArchiveArtifactRestoreSnapshot) {
    const normalized = normalizeArtifactSnapshot(snapshot);
    validateArtifactSnapshot(normalized);
    Object.assign(this, normalized);
    Object.freeze(this);
  }

  static register(
    input: RegisterArchiveArtifact,
    identity: { id: string; nowMs: number },
  ): ArchiveArtifact {
    return new ArchiveArtifact({
      ...input,
      id: identity.id,
      state: "pending",
      currentVerifiedAttemptId: null,
      createdAtMs: identity.nowMs,
      updatedAtMs: identity.nowMs,
      localDeletedAtMs: null,
      revision: 0,
      admission: {
        state: 'ready' as const,
        motionDayPath: null,
        nextAttemptMs: 0,
        errorCode: null,
        revision: 0,
      },
    });
  }

  static restore(snapshot: ArchiveArtifactRestoreSnapshot): ArchiveArtifact {
    return new ArchiveArtifact(snapshot);
  }

  withTrustedPath(trustedPath: string): ArchiveArtifact {
    if (trustedPath !== this.trustedPath) {
      throw new DriveObjectConflictError("Archive trusted path is immutable");
    }
    return this;
  }

  stabilize(nowMs: number): ArchiveArtifact {
    return this.transition("stabilizing", nowMs);
  }

  markPending(nowMs: number): ArchiveArtifact {
    return this.transition("pending", nowMs);
  }

  markVerified(attemptId: string, nowMs: number): ArchiveArtifact {
    requireText(attemptId, "Verified attempt ID");
    if (
      this.currentVerifiedAttemptId !== null &&
      this.currentVerifiedAttemptId !== attemptId
    ) {
      throw new DriveObjectConflictError(
        "Current verified attempt is immutable",
      );
    }
    return this.transition("verified", nowMs, {
      currentVerifiedAttemptId: attemptId,
    });
  }

  /**
   * A missing or detached current remote object must not strand the artifact:
   * its historical attempt remains immutable while a newly reserved object can
   * become the next verified copy.
   */
  markCurrentVerificationUnavailable(
    attemptId: string,
    nowMs: number,
  ): ArchiveArtifact {
    requireText(attemptId, "Verified attempt ID");
    if (this.currentVerifiedAttemptId !== attemptId) return this;
    return this.transition("pending", nowMs, {
      currentVerifiedAttemptId: null,
    });
  }

  markLocalMissing(nowMs: number): ArchiveArtifact {
    return this.transition("local_missing", nowMs, { localDeletedAtMs: nowMs });
  }

  supersede(nowMs: number): ArchiveArtifact {
    return this.transition("superseded", nowMs);
  }

  private transition(
    state: ArchiveArtifactState,
    nowMs: number,
    update: Partial<
      Pick<
        ArchiveArtifactSnapshot,
        "currentVerifiedAttemptId" | "localDeletedAtMs"
      >
    > = {},
  ): ArchiveArtifact {
    if (this.state === state) return this;
    const legal: Record<ArchiveArtifactState, readonly ArchiveArtifactState[]> =
      {
        stabilizing: ["pending", "superseded"],
        pending: ["stabilizing", "verified", "local_missing", "superseded"],
        verified: ["pending", "local_missing", "superseded"],
        local_missing: ["superseded"],
        superseded: [],
      };
    if (!legal[this.state].includes(state)) {
      throw new DriveObjectConflictError(
        `Archive artifact cannot transition from ${this.state} to ${state}`,
      );
    }
    return new ArchiveArtifact({
      ...this,
      ...update,
      state,
      updatedAtMs: nowMs,
      revision: this.revision + 1,
    });
  }
}

export function canonicalSourceFingerprintInput(
  input: Pick<
    RegisterArchiveArtifact,
    "installationId" | "kind" | "relativePath" | "size" | "mtimeNs" | "sha256"
  >,
): string {
  const fields = [
    input.installationId,
    input.kind,
    input.relativePath,
    String(input.size),
    input.mtimeNs,
    input.sha256,
  ];
  return fields
    .map((field) => `${Buffer.byteLength(field, "utf8")}:${field}`)
    .join("\0");
}

function validateArtifactSnapshot(snapshot: ArchiveArtifactSnapshot): void {
  requireText(snapshot.id, "Archive artifact ID");
  requireText(snapshot.installationId, "Installation ID");
  if (snapshot.kind !== "motion_video" && snapshot.kind !== "database_backup") {
    throw new DriveObjectConflictError("Archive artifact kind is malformed");
  }
  requireText(snapshot.sourceIdentity, "Archive source identity");
  requireText(snapshot.trustedPath, "Archive trusted path");
  requireText(snapshot.relativePath, "Archive relative path");
  requireNonNegativeInteger(snapshot.size, "Archive size");
  if (!/^\d+$/u.test(snapshot.mtimeNs)) {
    throw new DriveObjectConflictError(
      "Archive modification time is malformed",
    );
  }
  requireNonNegativeInteger(snapshot.sourceTimeMs, "Archive source time");
  requireSha256(snapshot.sha256, "Archive SHA-256");
  requireSha256(snapshot.sourceFingerprint, "Archive source fingerprint");
  if (!isArtifactState(snapshot.state)) {
    throw new DriveObjectConflictError("Archive artifact state is malformed");
  }
  if (snapshot.currentVerifiedAttemptId !== null) {
    requireText(
      snapshot.currentVerifiedAttemptId,
      "Current verified attempt ID",
    );
  }
  requireNonNegativeInteger(snapshot.createdAtMs, "Archive creation time");
  requireNonNegativeInteger(snapshot.updatedAtMs, "Archive update time");
  if (snapshot.localDeletedAtMs !== null) {
    requireNonNegativeInteger(
      snapshot.localDeletedAtMs,
      "Archive local deletion time",
    );
  }
  requireNonNegativeInteger(snapshot.revision, "Archive revision");
  if (snapshot.admission.state !== 'ready') {
    throw new DriveObjectConflictError('Archive admission state is malformed');
  }
  if (snapshot.admission.motionDayPath !== null) {
    requireText(snapshot.admission.motionDayPath, 'Archive motion day path');
  }
  requireNonNegativeInteger(snapshot.admission.nextAttemptMs, 'Archive admission next attempt');
  if (snapshot.admission.errorCode !== null) {
    requireText(snapshot.admission.errorCode, 'Archive admission error code');
  }
  requireNonNegativeInteger(snapshot.admission.revision, 'Archive admission revision');
}

function normalizeArtifactSnapshot(snapshot: ArchiveArtifactRestoreSnapshot): ArchiveArtifactSnapshot {
  return {
    ...snapshot,
    admission: snapshot.admission ?? {
      state: 'ready',
      motionDayPath: null,
      nextAttemptMs: 0,
      errorCode: null,
      revision: 0,
    },
  };
}

function isArtifactState(value: unknown): value is ArchiveArtifactState {
  return (
    value === "stabilizing" ||
    value === "pending" ||
    value === "verified" ||
    value === "local_missing" ||
    value === "superseded"
  );
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value) {
    throw new DriveObjectConflictError(`${label} is missing`);
  }
}

function requireSha256(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw new DriveObjectConflictError(`${label} is malformed`);
  }
}

function requireNonNegativeInteger(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DriveObjectConflictError(`${label} is malformed`);
  }
}
