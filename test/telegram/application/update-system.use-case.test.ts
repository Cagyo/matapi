import { describe, expect, it, vi } from "vitest";
import type { CheckedReleaseIdentity } from "../../../src/system/domain/ota-contracts";
import type { OtaPort } from "../../../src/system/domain/ports/ota.port";
import { UpdateSystemUseCase } from "../../../src/telegram/application/update-system.use-case";

const checked = {
  artifact: {
    version: "1.0.0",
    commit: "a".repeat(40),
    targetName: "linux-armv7-glibc",
    target: {
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcMinVersion: "2.28",
      nodeModulesAbi: "115",
    },
    url: "https://example.test/a.tar.gz",
    format: "tar.gz",
    size: 1,
    expandedSize: 1,
    maxPreparedSize: 1,
    maxPreparedFiles: 1,
    fileCount: 1,
    sha256: "b".repeat(64),
  },
  metadata: {
    metadataVersion: 1,
    channel: "stable",
    payloadSha256: "c".repeat(64),
    publishedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-02-01T00:00:00.000Z",
  },
} satisfies CheckedReleaseIdentity;
const receipt = {
  schemaVersion: 1 as const,
  operationId: "AAAAAAAAAAAAAAAAAAAAAA",
  kind: "update" as const,
  acceptedAt: "2030-01-02T00:00:00.000Z",
  requestSha256: "d".repeat(64),
  receiptGeneration: 1,
};

function fixture(
  authorization: "authorized" | "invalid-workflow" = "authorized",
) {
  const events: string[] = [];
  const ota: OtaPort = {
    checkForUpdates: vi.fn(async () => ({
      kind: "available",
      installed: checked.artifact,
      available: checked,
    })),
    reserveUpdate: vi.fn(async (identity) => {
      events.push("reserve");
      expect(identity).toBe(checked);
      return { kind: "reserved", receipt };
    }),
    reserveRollback: vi.fn(),
    publish: vi.fn(async () => {
      events.push("publish");
      return { kind: "started", receipt };
    }),
    cancel: vi.fn(async () => {
      events.push("cancel");
      return true;
    }),
  };
  const routes = {
    authorize: vi.fn(async () => {
      events.push("authorize");
      return authorization;
    }),
    revoke: vi.fn(async () => true),
    claimDelivery: vi.fn(),
    markDelivered: vi.fn(),
    acknowledge: vi.fn(),
  };
  return { useCase: new UpdateSystemUseCase(ota, routes), ota, routes, events };
}

describe("UpdateSystemUseCase", () => {
  it("returns the exact signed check result without refetching", async () => {
    const h = fixture();
    const result = await h.useCase.check();
    expect(result).toMatchObject({ kind: "available", available: checked });
    expect(h.ota.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("durably authorizes the exact workflow route before publication", async () => {
    const h = fixture();
    await expect(
      h.useCase.launch({
        checked,
        userId: 10,
        chatId: 20,
        workflowReceiptId: "1234567890abcdef",
      }),
    ).resolves.toEqual({
      kind: "started",
      commit: checked.artifact.commit,
      operationId: receipt.operationId,
    });
    expect(h.events).toEqual(["reserve", "authorize", "publish"]);
    expect(h.routes.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: receipt.operationId,
        operationKind: "update",
        userId: 10,
        chatId: 20,
        workflowReceiptId: "1234567890abcdef",
      }),
    );
  });

  it("removes an unauthorized reservation and never publishes it", async () => {
    const h = fixture("invalid-workflow");
    await expect(
      h.useCase.launch({
        checked,
        userId: 10,
        chatId: 20,
        workflowReceiptId: "1234567890abcdef",
      }),
    ).resolves.toEqual({
      kind: "failure",
      failure: { code: "maintenance-required" },
    });
    expect(h.events).toEqual(["reserve", "authorize", "cancel"]);
    expect(h.ota.publish).not.toHaveBeenCalled();
  });
});
