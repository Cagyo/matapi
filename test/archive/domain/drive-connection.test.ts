import { describe, expect, it } from "vitest";
import { DriveConnection } from "../../../src/archive/domain/drive-connection.entity";
import { DriveObjectConflictError } from "../../../src/archive/domain/errors/drive-object-conflict.error";

const activation = (nowMs: number) => ({
  permissionId: "owner-1",
  email: "owner@example.test",
  displayName: "Owner",
  folders: {
    rootId: "root-1",
    motionId: "motion-1",
    backupsId: "backups-1",
  },
  nowMs,
});

describe("DriveConnection", () => {
  it("does not retain mutable folder IDs from a restored snapshot", () => {
    const active = DriveConnection.stage({
      id: "generation-1",
      installationId: "installation-1",
      nowMs: 1,
    }).activate(activation(2));
    const folders = { ...active.folders! };
    const restored = DriveConnection.restore({ ...active, folders });

    folders.rootId = "other-root";

    expect(restored.folders).toEqual({
      rootId: "root-1",
      motionId: "motion-1",
      backupsId: "backups-1",
    });
    expect(() => {
      (restored.folders as { rootId: string }).rootId = "other-root";
    }).toThrow(TypeError);
  });

  it("requires a new generation when reauthorization changes account binding", () => {
    const reauthorizationRequired = DriveConnection.stage({
      id: "generation-1",
      installationId: "installation-1",
      nowMs: 1,
    })
      .activate(activation(2))
      .requireReauthorization(3);

    expect(() =>
      reauthorizationRequired.activate({
        ...activation(4),
        permissionId: "owner-2",
      }),
    ).toThrow(DriveObjectConflictError);
  });

  it("requires a new generation when reauthorization changes managed folders", () => {
    const reauthorizationRequired = DriveConnection.stage({
      id: "generation-1",
      installationId: "installation-1",
      nowMs: 1,
    })
      .activate(activation(2))
      .requireReauthorization(3);

    expect(() =>
      reauthorizationRequired.activate({
        ...activation(4),
        folders: {
          ...activation(4).folders,
          backupsId: "other-backups",
        },
      }),
    ).toThrow(DriveObjectConflictError);
  });
});
