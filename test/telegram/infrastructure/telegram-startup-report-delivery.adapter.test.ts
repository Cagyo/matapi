import { describe, expect, it, vi } from "vitest";
import type { StartupReport } from "../../../src/system/domain/ota-contracts";
import { TelegramStartupReportDeliveryAdapter } from "../../../src/telegram/infrastructure/telegram-startup-report-delivery.adapter";

const report: StartupReport = {
  schemaVersion: 1,
  operationId: "AAAAAAAAAAAAAAAAAAAAAA",
  kind: "update",
  outcome: "updated",
  artifactSha256: "a".repeat(64),
  metadataSha256: "b".repeat(64),
  failure: null,
  writtenAt: "2030-01-01T00:00:00.000Z",
};
const admin = {
  telegramId: 100,
  name: "Admin",
  role: "admin",
  locale: "en",
  muted: false,
  nonCriticalPausedUntil: null,
  notificationPauseRevision: 0,
  quietStart: null,
  quietEnd: null,
  createdAt: null,
} as const;

describe("TelegramStartupReportDeliveryAdapter", () => {
  it("routes an exact operation only to its mapped chat and persists CAS before reporting delivery", async () => {
    const events: string[] = [];
    const routes = {
      claimDelivery: vi.fn(async () => ({
        kind: "claimed",
        route: {
          operationId: report.operationId!,
          operationKind: "update",
          userId: 100,
          chatId: 200,
          workflowReceiptId: "1234567890abcdef",
          workflow: "ota-update",
        },
      })),
      markDelivered: vi.fn(async () => {
        events.push("delivered");
        return true;
      }),
      acknowledge: vi.fn(async () => {
        events.push("acknowledged");
        return true;
      }),
      authorize: vi.fn(),
      revoke: vi.fn(),
    };
    const users = {
      findByTelegramId: vi.fn(async () => admin),
      listRecipients: vi.fn(),
    };
    const messenger = {
      send: vi.fn(async (chatId: number) => {
        events.push(`send:${chatId}`);
      }),
    };
    const workflows = {
      completeHeadless: vi.fn(async (input) => {
        expect(input.workflow).toBe("ota-update");
        await input.deliver();
        return "completed";
      }),
    };
    const adapter = new TelegramStartupReportDeliveryAdapter(
      routes,
      users as never,
      messenger,
      workflows as never,
      {} as never,
    );

    await expect(adapter.deliver(report)).resolves.toEqual({ delivered: 1 });

    expect(events).toEqual(["send:200", "delivered", "acknowledged"]);
    expect(users.findByTelegramId).toHaveBeenCalledWith(100);
  });

  it("delivers a null-operation maintenance report only to current admins", async () => {
    const users = {
      listRecipients: vi.fn(async () => [
        admin,
        { ...admin, telegramId: 101, role: "user" },
      ]),
      findByTelegramId: vi.fn(),
    };
    const messenger = { send: vi.fn(async () => undefined) };
    const adapter = new TelegramStartupReportDeliveryAdapter(
      {} as never,
      users as never,
      messenger,
      {} as never,
      {} as never,
    );
    const maintenance: StartupReport = {
      ...report,
      operationId: null,
      kind: null,
      outcome: "maintenance-required",
      artifactSha256: null,
      metadataSha256: null,
      failure: { code: "maintenance-required" },
    };

    await expect(adapter.deliver(maintenance)).resolves.toEqual({
      delivered: 1,
    });
    expect(messenger.send).toHaveBeenCalledTimes(1);
    expect(messenger.send).toHaveBeenCalledWith(100, expect.any(String));
  });
});
