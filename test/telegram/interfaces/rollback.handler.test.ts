import { describe, expect, it, vi } from "vitest";
import { catalogFor } from "../../../src/locales";
import { RollbackHandler } from "../../../src/telegram/interfaces/rollback.handler";

const receipt = {
  id: "abcdefghijklmnop",
  userId: 42,
  chatId: 43,
  kind: "workflow-return",
  sessionToken: null,
  status: "pending",
  expiresAt: new Date("2030-01-02T00:00:00.000Z"),
  payload: {
    workflow: "ota-rollback",
    phase: "cancellable",
    originSource: "natural-parent",
    origin: { kind: "admin-system" },
  },
} as const;

describe("RollbackHandler exact OTA workflow", () => {
  it("marks the exact rollback receipt running before launch", async () => {
    const events: string[] = [];
    const rollback = {
      launch: vi.fn(async () => {
        events.push("launch");
        return { kind: "started", operationId: "AAAAAAAAAAAAAAAAAAAAAA" };
      }),
    };
    const workflows = {
      begin: vi.fn(async () => receipt),
      markRunning: vi.fn(async () => {
        events.push("running");
        return true;
      }),
    };
    const handler = new RollbackHandler(
      rollback as never,
      { adminOnly: vi.fn() } as never,
      workflows as never,
    );
    const commands: Record<string, (ctx: never) => Promise<void>> = {};
    handler.register({
      command: vi.fn((name, _guard, fn) => {
        commands[name] = fn;
      }),
    } as never);
    const ctx = {
      from: { id: 42 },
      chat: { id: 43, type: "private" },
      localeState: { catalog: catalogFor("en") },
      reply: vi.fn(async () => undefined),
    };

    await commands.rollback(ctx as never);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, "ota-rollback", {
      source: "natural-parent",
    });
    expect(events).toEqual(["running", "launch"]);
    expect(rollback.launch).toHaveBeenCalledWith({
      userId: 42,
      chatId: 43,
      workflowReceiptId: receipt.id,
    });
  });
});
