import { describe, expect, it, vi } from "vitest";
import type {
  CheckedReleaseIdentity,
  OtaOperationReceipt,
} from "../../../src/system/domain/ota-contracts";
import { SignedFeedOtaAdapter } from "../../../src/system/infrastructure/signed-feed-ota.adapter";
import { OtaWorkflowBindingRegistry } from "../../../src/system/application/ota-workflow-binding.registry";

const checked = {
  artifact: {
    version: "1.4.2",
    commit: "0123456789abcdef0123456789abcdef01234567",
    targetName: "linux-armv7-glibc",
    target: {
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcMinVersion: "2.28",
      nodeModulesAbi: "115",
    },
    url: "https://updates.example.test/release.tar.gz",
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
    expiresAt: "2030-01-31T00:00:00.000Z",
  },
} satisfies CheckedReleaseIdentity;

const receipt: OtaOperationReceipt = {
  schemaVersion: 1,
  operationId: "AAAAAAAAAAAAAAAAAAAAAA",
  kind: "update",
  acceptedAt: "2030-01-02T00:00:00.000Z",
  requestSha256: "c".repeat(64),
  receiptGeneration: 1,
};
const workflow = {
  userId: 10,
  chatId: 20,
  workflowReceiptId: "1234567890abcdef",
};

function harness(bound = true) {
  const events: string[] = [];
  const launcher = {
    reserveUpdate: vi.fn(async () => {
      events.push("reserve");
      return { kind: "reserved" as const, receipt };
    }),
    reserveRollback: vi.fn(),
    publish: vi.fn(async () => {
      events.push("publish");
      return { kind: "started" as const, receipt };
    }),
    cancel: vi.fn(async () => {
      events.push("cancel");
      return true;
    }),
  };
  const bindings = {
    bind: vi.fn(async () => {
      events.push("bind");
      return bound;
    }),
  };
  return {
    ota: new SignedFeedOtaAdapter(
      { execute: vi.fn() } as never,
      launcher,
      bindings as never,
    ),
    launcher,
    bindings,
    events,
  };
}

describe("SignedFeedOtaAdapter", () => {
  it("reserves, durably binds the workflow, then publishes the exact update", async () => {
    const h = harness();

    await expect(h.ota.startUpdate(checked, workflow)).resolves.toEqual({
      kind: "started",
      receipt,
    });

    expect(h.events).toEqual(["reserve", "bind", "publish"]);
    expect(h.launcher.reserveUpdate).toHaveBeenCalledWith(checked, undefined);
    expect(h.bindings.bind).toHaveBeenCalledWith({ receipt, workflow });
  });

  it("cancels a failed durable binding and never publishes", async () => {
    const h = harness(false);

    await expect(h.ota.startUpdate(checked, workflow)).resolves.toEqual({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });

    expect(h.events).toEqual(["reserve", "bind", "cancel"]);
    expect(h.launcher.publish).not.toHaveBeenCalled();
  });

  it("fails closed when no durable binding delegate is registered", async () => {
    const h = harness();
    const ota = new SignedFeedOtaAdapter(
      { execute: vi.fn() } as never,
      h.launcher,
      new OtaWorkflowBindingRegistry(),
    );

    await expect(ota.startUpdate(checked, workflow)).resolves.toEqual({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });
    expect(h.launcher.cancel).toHaveBeenCalledWith(receipt);
    expect(h.launcher.publish).not.toHaveBeenCalled();
  });

  it("rejects a missing workflow reference before creating a reservation", async () => {
    const h = harness();

    await expect(h.ota.startUpdate(checked, undefined as never)).resolves.toEqual({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });

    expect(h.launcher.reserveUpdate).not.toHaveBeenCalled();
    expect(h.bindings.bind).not.toHaveBeenCalled();
  });

  it("does not revoke a durable binding when publication reports failure", async () => {
    const h = harness();
    h.launcher.publish.mockResolvedValueOnce({
      kind: "rejected",
      failure: { code: "operation-in-progress" },
    });

    await expect(h.ota.startUpdate(checked, workflow)).resolves.toEqual({
      kind: "rejected",
      failure: { code: "operation-in-progress" },
    });

    expect(h.events).toEqual(["reserve", "bind"]);
    expect(h.launcher.publish).toHaveBeenCalledWith(receipt, undefined);
    expect(h.launcher.cancel).not.toHaveBeenCalled();
  });

  it("retains the durable binding when publication crashes", async () => {
    const h = harness();
    h.launcher.publish.mockRejectedValueOnce(new Error("publish crashed"));

    await expect(h.ota.startUpdate(checked, workflow)).resolves.toEqual({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });
    expect(h.bindings.bind).toHaveBeenCalledOnce();
    expect(h.launcher.cancel).not.toHaveBeenCalled();
  });
});
