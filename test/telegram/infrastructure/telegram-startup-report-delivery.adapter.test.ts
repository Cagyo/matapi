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
      sendConfirmed: vi.fn(async (chatId: number) => {
        events.push(`send:${chatId}`);
        return true;
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

  it("leaves the exact route and report pending when Telegram rejects delivery", async () => {
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
      markDelivered: vi.fn(),
      acknowledge: vi.fn(),
      authorize: vi.fn(),
      revoke: vi.fn(),
    };
    const messenger = {
      sendConfirmed: vi.fn().mockRejectedValue(new Error("Telegram rejected")),
    };
    const workflows = {
      completeHeadless: vi.fn(async (input) => {
        try {
          await input.deliver();
          return "completed";
        } catch {
          return "resumable";
        }
      }),
    };
    const adapter = new TelegramStartupReportDeliveryAdapter(
      routes,
      { findByTelegramId: vi.fn(async () => admin) } as never,
      messenger,
      workflows,
      {} as never,
    );

    await expect(adapter.deliver(report)).resolves.toEqual({ delivered: 0 });
    expect(messenger.sendConfirmed).toHaveBeenCalledWith(200, expect.any(String));
    expect(routes.markDelivered).not.toHaveBeenCalled();
    expect(routes.acknowledge).not.toHaveBeenCalled();
  });

  it("marks and acknowledges a route whose exact workflow already completed", async () => {
    const routes = {
      claimDelivery: vi.fn(async () => ({
        kind: "workflow-completed",
        route: {
          operationId: report.operationId!,
          operationKind: "update",
          userId: 100,
          chatId: 200,
          workflowReceiptId: "1234567890abcdef",
          workflow: "ota-update",
        },
      })),
      markDelivered: vi.fn(async () => true),
      acknowledge: vi.fn(async () => true),
      authorize: vi.fn(),
      revoke: vi.fn(),
    };
    const messenger = { sendConfirmed: vi.fn() };
    const adapter = new TelegramStartupReportDeliveryAdapter(
      routes,
      {} as never,
      messenger,
      {} as never,
      {} as never,
    );

    await expect(adapter.deliver(report)).resolves.toEqual({ delivered: 1 });
    expect(messenger.sendConfirmed).not.toHaveBeenCalled();
    expect(routes.markDelivered).toHaveBeenCalledWith({
      operationId: report.operationId,
      leaseId: expect.any(String),
      deliveredAt: expect.any(Date),
    });
    expect(routes.acknowledge).toHaveBeenCalled();
  });

  it("reports an already acknowledged route as delivered without resending", async () => {
    const routes = {
      claimDelivery: vi.fn(async () => ({ kind: "acknowledged" })),
    };
    const messenger = { sendConfirmed: vi.fn() };
    const adapter = new TelegramStartupReportDeliveryAdapter(
      routes as never,
      {} as never,
      messenger,
      {} as never,
      {} as never,
    );

    await expect(adapter.deliver(report)).resolves.toEqual({ delivered: 1 });
    expect(messenger.sendConfirmed).not.toHaveBeenCalled();
  });

  it("delivers a null-operation maintenance report only to current admins", async () => {
    const users = {
      listRecipients: vi.fn(async () => [
        admin,
        { ...admin, telegramId: 101, role: "user" },
      ]),
      findByTelegramId: vi.fn(),
    };
    const messenger = { sendConfirmed: vi.fn(async () => true) };
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
    expect(messenger.sendConfirmed).toHaveBeenCalledTimes(1);
    expect(messenger.sendConfirmed).toHaveBeenCalledWith(100, expect.any(String));
  });

  it("does not acknowledge a maintenance report when every send is unconfirmed", async () => {
    const users = {
      listRecipients: vi.fn(async () => [admin]),
      findByTelegramId: vi.fn(),
    };
    const messenger = { sendConfirmed: vi.fn(async () => false) };
    const adapter = new TelegramStartupReportDeliveryAdapter(
      {} as never,
      users as never,
      messenger,
      {} as never,
      {} as never,
    );

    await expect(
      adapter.deliver({
        ...report,
        operationId: null,
        kind: null,
        outcome: "maintenance-required",
        artifactSha256: null,
        metadataSha256: null,
        failure: { code: "maintenance-required" },
      }),
    ).resolves.toEqual({ delivered: 0 });
  });
});
