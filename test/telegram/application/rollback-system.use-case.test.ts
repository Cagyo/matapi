import { describe, expect, it, vi } from "vitest";
import type { OtaPort } from "../../../src/system/domain/ports/ota.port";
import { RollbackSystemUseCase } from "../../../src/telegram/application/rollback-system.use-case";

const receipt = {
  schemaVersion: 1 as const,
  operationId: "AAAAAAAAAAAAAAAAAAAAAA",
  kind: "rollback" as const,
  acceptedAt: "2030-01-02T00:00:00.000Z",
  requestSha256: "d".repeat(64),
  receiptGeneration: 1,
};

describe("RollbackSystemUseCase", () => {
  it("passes the exact rollback workflow reference to the safe OTA coordinator", async () => {
    const ota: OtaPort = {
      checkForUpdates: vi.fn(),
      startUpdate: vi.fn(),
      startRollback: vi.fn(async () => ({ kind: "started", receipt })),
    };
    const useCase = new RollbackSystemUseCase(ota);
    const workflow = { userId: 10, chatId: 20, workflowReceiptId: "1234567890abcdef" };

    await expect(useCase.launch(workflow)).resolves.toEqual({
      kind: "started",
      operationId: receipt.operationId,
    });
    expect(ota.startRollback).toHaveBeenCalledWith(workflow);
  });
});
