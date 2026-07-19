import { describe, expect, it, vi } from "vitest";
import type { CheckedReleaseIdentity } from "../../../src/system/domain/ota-contracts";
import type { OtaPort } from "../../../src/system/domain/ports/ota.port";
import { UpdateSystemUseCase } from "../../../src/telegram/application/update-system.use-case";

const checked = {
  artifact: {
    version: "1.0.0",
    commit: "a".repeat(40),
    targetName: "linux-armv7-glibc",
    target: { platform: "linux", arch: "arm", libc: "glibc", libcMinVersion: "2.28", nodeModulesAbi: "115" },
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

function fixture() {
  const ota: OtaPort = {
    checkForUpdates: vi.fn(async () => ({ kind: "available", installed: checked.artifact, available: checked })),
    startUpdate: vi.fn(async () => ({ kind: "started", receipt })),
    startRollback: vi.fn(),
  };
  return { useCase: new UpdateSystemUseCase(ota), ota };
}

describe("UpdateSystemUseCase", () => {
  it("returns the exact signed check result without refetching", async () => {
    const h = fixture();
    await expect(h.useCase.check()).resolves.toMatchObject({ kind: "available", available: checked });
    expect(h.ota.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("passes the exact workflow reference to the safe OTA coordinator", async () => {
    const h = fixture();
    const workflow = { userId: 10, chatId: 20, workflowReceiptId: "1234567890abcdef" };

    await expect(h.useCase.launch({ checked, ...workflow })).resolves.toEqual({
      kind: "started",
      commit: checked.artifact.commit,
      operationId: receipt.operationId,
    });
    expect(h.ota.startUpdate).toHaveBeenCalledWith(checked, workflow);
  });
});
