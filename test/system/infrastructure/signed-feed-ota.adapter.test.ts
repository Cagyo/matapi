import { describe, expect, it, vi } from "vitest";
import type {
  CheckedReleaseIdentity,
  OtaOperationReceipt,
} from "../../../src/system/domain/ota-contracts";
import { SignedFeedOtaAdapter } from "../../../src/system/infrastructure/signed-feed-ota.adapter";

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

describe("SignedFeedOtaAdapter", () => {
  it("passes the exact identity returned by one signed check into reservation", async () => {
    const checks = {
      execute: vi
        .fn()
        .mockResolvedValue({
          kind: "available",
          installed: checked.artifact,
          available: checked,
        }),
    };
    const launcher = {
      reserveUpdate: vi.fn().mockResolvedValue({ kind: "reserved", receipt }),
      reserveRollback: vi.fn(),
      publish: vi.fn(),
      cancel: vi.fn(),
      startUpdate: vi.fn(),
      startRollback: vi.fn(),
    };
    const ota = new SignedFeedOtaAdapter(checks as never, launcher);

    const result = await ota.checkForUpdates();
    if (result.kind !== "available")
      throw new Error("expected available release");
    await ota.reserveUpdate(result.available);

    expect(checks.execute).toHaveBeenCalledOnce();
    expect(launcher.reserveUpdate).toHaveBeenCalledWith(checked, undefined);
    expect(launcher.reserveUpdate.mock.calls[0][0]).toBe(checked);
  });

  it("delegates publication and cancellation only by the reservation receipt", async () => {
    const launcher = {
      reserveUpdate: vi.fn(),
      reserveRollback: vi.fn(),
      publish: vi.fn().mockResolvedValue({ kind: "started", receipt }),
      cancel: vi.fn().mockResolvedValue(true),
      startUpdate: vi.fn(),
      startRollback: vi.fn(),
    };
    const ota = new SignedFeedOtaAdapter(
      { execute: vi.fn() } as never,
      launcher,
    );

    await expect(ota.publish(receipt)).resolves.toEqual({
      kind: "started",
      receipt,
    });
    await expect(ota.cancel(receipt)).resolves.toBe(true);
    expect(launcher.publish).toHaveBeenCalledWith(receipt, undefined);
    expect(launcher.cancel).toHaveBeenCalledWith(receipt);
  });
});
