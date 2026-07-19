import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../src/database/schema";
import { DrizzleOtaOperationWorkflowRepository } from "../../../src/telegram/infrastructure/drizzle-ota-operation-workflow.repository";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const LATER = new Date("2030-01-01T01:00:00.000Z");
const OPERATION_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const RECEIPT_ID = "1234567890abcdef";

describe("DrizzleOtaOperationWorkflowRepository", () => {
  let sqlite: Database.Database;
  let repository: DrizzleOtaOperationWorkflowRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: "./migrations" });
    sqlite
      .prepare(
        "INSERT INTO users (telegram_id, name, role, locale) VALUES (?, ?, ?, ?)",
      )
      .run(100, "Admin", "admin", "en");
    sqlite
      .prepare(
        "INSERT INTO home_action_receipts (user_id, chat_id, kind, id, session_token, status, payload, expires_at, updated_at) VALUES (?, ?, 'workflow-return', ?, NULL, 'pending', ?, ?, ?)",
      )
      .run(
        100,
        200,
        RECEIPT_ID,
        JSON.stringify({
          workflow: "ota-update",
          phase: "running",
          originSource: "natural-parent",
          origin: { kind: "admin-system" },
          deliveryStage: "pending",
        }),
        LATER.getTime() / 1_000,
        NOW.getTime() / 1_000,
      );
    repository = new DrizzleOtaOperationWorkflowRepository(db);
  });

  afterEach(() => sqlite.close());

  it("authorizes only the exact user, private chat, receipt, workflow, and running stage", async () => {
    await expect(
      repository.authorize({
        operationId: OPERATION_ID,
        operationKind: "update",
        userId: 100,
        chatId: 201,
        workflowReceiptId: RECEIPT_ID,
        authorizedAt: NOW,
      }),
    ).resolves.toBe("invalid-workflow");

    await expect(
      repository.authorize({
        operationId: OPERATION_ID,
        operationKind: "update",
        userId: 100,
        chatId: 200,
        workflowReceiptId: RECEIPT_ID,
        authorizedAt: NOW,
      }),
    ).resolves.toBe("authorized");

    expect(
      sqlite
        .prepare(
          "SELECT operation_id, user_id, chat_id, workflow_receipt_id, authorized_at FROM ota_operation_workflows",
        )
        .get(),
    ).toEqual({
      operation_id: OPERATION_ID,
      user_id: 100,
      chat_id: 200,
      workflow_receipt_id: RECEIPT_ID,
      authorized_at: NOW.getTime() / 1_000,
    });
  });

  it("leases one delivery and durably advances delivered then acknowledged with CAS", async () => {
    await repository.authorize({
      operationId: OPERATION_ID,
      operationKind: "update",
      userId: 100,
      chatId: 200,
      workflowReceiptId: RECEIPT_ID,
      authorizedAt: NOW,
    });

    await expect(
      repository.claimDelivery({
        operationId: OPERATION_ID,
        operationKind: "update",
        leaseId: "lease-a",
        now: NOW,
        leaseUntil: LATER,
      }),
    ).resolves.toMatchObject({
      kind: "claimed",
      route: {
        userId: 100,
        chatId: 200,
        workflowReceiptId: RECEIPT_ID,
        workflow: "ota-update",
      },
    });
    await expect(
      repository.claimDelivery({
        operationId: OPERATION_ID,
        operationKind: "update",
        leaseId: "lease-b",
        now: NOW,
        leaseUntil: LATER,
      }),
    ).resolves.toEqual({ kind: "busy" });

    await expect(
      repository.markDelivered({
        operationId: OPERATION_ID,
        leaseId: "lease-a",
        deliveredAt: NOW,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.acknowledge({
        operationId: OPERATION_ID,
        leaseId: "lease-a",
        acknowledgedAt: NOW,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.claimDelivery({
        operationId: OPERATION_ID,
        operationKind: "update",
        leaseId: "lease-c",
        now: NOW,
        leaseUntil: LATER,
      }),
    ).resolves.toEqual({ kind: "acknowledged" });
  });
});
