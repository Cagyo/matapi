import { describe, expect, it, vi } from "vitest";
import { OtaWorkflowBindingRegistry } from "../../../src/system/application/ota-workflow-binding.registry";
import { TelegramOtaWorkflowBindingAdapter } from "../../../src/telegram/infrastructure/telegram-ota-workflow-binding.adapter";

const request = {
  receipt: {
    schemaVersion: 1 as const,
    operationId: "AAAAAAAAAAAAAAAAAAAAAA",
    kind: "update" as const,
    acceptedAt: "2030-01-02T00:00:00.000Z",
    requestSha256: "d".repeat(64),
    receiptGeneration: 1,
  },
  workflow: {
    userId: 10,
    chatId: 20,
    workflowReceiptId: "1234567890abcdef",
  },
};

describe("TelegramOtaWorkflowBindingAdapter", () => {
  it("registers the exact durable authorization delegate and clears it on shutdown", async () => {
    const registry = new OtaWorkflowBindingRegistry();
    const routes = {
      authorize: vi.fn(async () => "authorized" as const),
    };
    const adapter = new TelegramOtaWorkflowBindingAdapter(
      registry,
      routes as never,
    );

    await expect(registry.bind(request)).resolves.toBe(false);
    adapter.onModuleInit();
    await expect(registry.bind(request)).resolves.toBe(true);
    expect(routes.authorize).toHaveBeenCalledWith({
      operationId: request.receipt.operationId,
      operationKind: "update",
      userId: 10,
      chatId: 20,
      workflowReceiptId: "1234567890abcdef",
      authorizedAt: new Date(request.receipt.acceptedAt),
    });

    adapter.onModuleDestroy();
    await expect(registry.bind(request)).resolves.toBe(false);
  });
});
