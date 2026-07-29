import { DriveObjectConflictError } from "./errors/drive-object-conflict.error";

export type DriveConnectionStatus =
  | "staged"
  | "active"
  | "reauth_required"
  | "retiring"
  | "retired_unmanaged"
  | "disconnecting"
  | "disconnected";

export interface DriveConnectionSnapshot {
  id: string;
  installationId: string;
  status: DriveConnectionStatus;
  revision: number;
  permissionId: string | null;
  email: string | null;
  displayName: string | null;
  folders: Readonly<{
    rootId: string;
    motionId: string;
    backupsId: string;
  }> | null;
  createdAtMs: number;
  updatedAtMs: number;
  activatedAtMs: number | null;
  retiredAtMs: number | null;
}

export class DriveConnection implements DriveConnectionSnapshot {
  readonly id!: string;
  readonly installationId!: string;
  readonly status!: DriveConnectionStatus;
  readonly revision!: number;
  readonly permissionId!: string | null;
  readonly email!: string | null;
  readonly displayName!: string | null;
  readonly folders!: Readonly<{
    rootId: string;
    motionId: string;
    backupsId: string;
  }> | null;
  readonly createdAtMs!: number;
  readonly updatedAtMs!: number;
  readonly activatedAtMs!: number | null;
  readonly retiredAtMs!: number | null;

  private constructor(snapshot: DriveConnectionSnapshot) {
    validateConnection(snapshot);
    Object.assign(this, snapshot);
    Object.freeze(this);
  }

  static stage(input: {
    id: string;
    installationId: string;
    nowMs: number;
  }): DriveConnection {
    return new DriveConnection({
      ...input,
      status: "staged",
      revision: 0,
      permissionId: null,
      email: null,
      displayName: null,
      folders: null,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
      activatedAtMs: null,
      retiredAtMs: null,
    });
  }

  static restore(snapshot: DriveConnectionSnapshot): DriveConnection {
    return new DriveConnection(snapshot);
  }

  activate(input: {
    permissionId: string;
    email: string | null;
    displayName: string | null;
    folders: { rootId: string; motionId: string; backupsId: string };
    nowMs: number;
  }): DriveConnection {
    return this.transition("active", input.nowMs, {
      permissionId: input.permissionId,
      email: input.email,
      displayName: input.displayName,
      folders: Object.freeze({ ...input.folders }),
      activatedAtMs: input.nowMs,
    });
  }

  requireReauthorization(nowMs: number): DriveConnection {
    return this.transition("reauth_required", nowMs);
  }

  beginRetirement(nowMs: number): DriveConnection {
    return this.transition("retiring", nowMs);
  }

  retireUnmanaged(nowMs: number): DriveConnection {
    return this.transition("retired_unmanaged", nowMs, { retiredAtMs: nowMs });
  }

  beginDisconnect(nowMs: number): DriveConnection {
    return this.transition("disconnecting", nowMs);
  }

  disconnect(nowMs: number): DriveConnection {
    return this.transition("disconnected", nowMs, { retiredAtMs: nowMs });
  }

  private transition(
    status: DriveConnectionStatus,
    nowMs: number,
    update: Partial<
      Pick<
        DriveConnectionSnapshot,
        | "permissionId"
        | "email"
        | "displayName"
        | "folders"
        | "activatedAtMs"
        | "retiredAtMs"
      >
    > = {},
  ): DriveConnection {
    const legal: Record<
      DriveConnectionStatus,
      readonly DriveConnectionStatus[]
    > = {
      staged: ["active"],
      active: ["reauth_required", "retiring", "disconnecting"],
      reauth_required: ["active", "retiring", "disconnecting"],
      retiring: ["retired_unmanaged"],
      retired_unmanaged: [],
      disconnecting: ["disconnected"],
      disconnected: [],
    };
    if (!legal[this.status].includes(status)) {
      throw new DriveObjectConflictError(
        `Drive connection cannot transition from ${this.status} to ${status}`,
      );
    }
    return new DriveConnection({
      ...this,
      ...update,
      status,
      updatedAtMs: nowMs,
      revision: this.revision + 1,
    });
  }
}

function validateConnection(snapshot: DriveConnectionSnapshot): void {
  requireText(snapshot.id, "Drive connection ID");
  requireText(snapshot.installationId, "Installation ID");
  if (!isConnectionStatus(snapshot.status)) {
    throw new DriveObjectConflictError("Drive connection status is malformed");
  }
  requireNonNegativeInteger(snapshot.revision, "Drive connection revision");
  requireNonNegativeInteger(
    snapshot.createdAtMs,
    "Drive connection creation time",
  );
  requireNonNegativeInteger(
    snapshot.updatedAtMs,
    "Drive connection update time",
  );
  if (snapshot.activatedAtMs !== null)
    requireNonNegativeInteger(snapshot.activatedAtMs, "Drive activation time");
  if (snapshot.retiredAtMs !== null)
    requireNonNegativeInteger(snapshot.retiredAtMs, "Drive retirement time");
  if (snapshot.status !== "staged") {
    requireText(snapshot.permissionId, "Drive permission ID");
    if (snapshot.folders === null) {
      throw new DriveObjectConflictError(
        "Active Drive connection lacks managed folders",
      );
    }
    requireText(snapshot.folders.rootId, "Drive root folder ID");
    requireText(snapshot.folders.motionId, "Drive motion folder ID");
    requireText(snapshot.folders.backupsId, "Drive backups folder ID");
  }
}

function isConnectionStatus(value: unknown): value is DriveConnectionStatus {
  return (
    value === "staged" ||
    value === "active" ||
    value === "reauth_required" ||
    value === "retiring" ||
    value === "retired_unmanaged" ||
    value === "disconnecting" ||
    value === "disconnected"
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
