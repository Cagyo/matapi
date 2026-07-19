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
  it("authorizes the exact rollback workflow before publishing", async () => {
    const events: string[] = [];
    const ota: OtaPort = {
      checkForUpdates: vi.fn(),
      reserveUpdate: vi.fn(),
      reserveRollback: vi.fn(async () => {
        events.push("reserve");
        return { kind: "reserved", receipt };
      }),
      publish: vi.fn(async () => {
        events.push("publish");
        return { kind: "started", receipt };
      }),
      cancel: vi.fn(),
    };
    const routes = {
      authorize: vi.fn(async () => {
        events.push("authorize");
        return "authorized" as const;
      }),
      revoke: vi.fn(),
      claimDelivery: vi.fn(),
      markDelivered: vi.fn(),
      acknowledge: vi.fn(),
    };
    const useCase = new RollbackSystemUseCase(ota, routes);

    await expect(
      useCase.launch({
        userId: 10,
        chatId: 20,
        workflowReceiptId: "1234567890abcdef",
      }),
    ).resolves.toEqual({ kind: "started", operationId: receipt.operationId });
    expect(events).toEqual(["reserve", "authorize", "publish"]);
    expect(routes.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKind: "rollback",
        userId: 10,
        chatId: 20,
      }),
    );
  });
});
