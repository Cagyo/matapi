import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { type AppDatabase, DB } from "../../database/database.module";
import {
  homeActionReceipts,
  otaOperationWorkflows,
} from "../../database/schema";
import type {
  OtaDeliveryClaim,
  OtaOperationKind,
  OtaOperationRoute,
  OtaOperationWorkflowRepositoryPort,
  OtaWorkflow,
} from "../application/ports/ota-operation-workflow-repository.port";

type Writer = Pick<AppDatabase, "insert" | "select" | "update" | "delete">;
type RouteRow = typeof otaOperationWorkflows.$inferSelect;

function expectedWorkflow(kind: OtaOperationKind): OtaWorkflow {
  return kind === "update" ? "ota-update" : "ota-rollback";
}

function decodeWorkflow(
  payload: string,
): { workflow: OtaWorkflow; phase: "running"; deliveryStage?: string } | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (
      (value.workflow === "ota-update" || value.workflow === "ota-rollback") &&
      value.phase === "running"
    ) {
      return {
        workflow: value.workflow,
        phase: value.phase,
        ...(typeof value.deliveryStage === "string"
          ? { deliveryStage: value.deliveryStage }
          : {}),
      };
    }
  } catch {
    // Persisted malformed workflow state is never authority.
  }
  return null;
}

function route(row: RouteRow): OtaOperationRoute {
  return {
    operationId: row.operationId,
    operationKind: row.operationKind as OtaOperationKind,
    userId: row.userId,
    chatId: row.chatId,
    workflowReceiptId: row.workflowReceiptId,
    workflow: expectedWorkflow(row.operationKind as OtaOperationKind),
  };
}

@Injectable()
export class DrizzleOtaOperationWorkflowRepository implements OtaOperationWorkflowRepositoryPort {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async authorize(input: {
    operationId: string;
    operationKind: OtaOperationKind;
    userId: number;
    chatId: number;
    workflowReceiptId: string;
    authorizedAt: Date;
  }): Promise<"authorized" | "invalid-workflow" | "conflict"> {
    return this.immediate((tx) => {
      const receipt = tx
        .select()
        .from(homeActionReceipts)
        .where(
          and(
            eq(homeActionReceipts.userId, input.userId),
            eq(homeActionReceipts.chatId, input.chatId),
            eq(homeActionReceipts.kind, "workflow-return"),
            eq(homeActionReceipts.id, input.workflowReceiptId),
          ),
        )
        .get();
      const workflow = receipt && decodeWorkflow(receipt.payload);
      if (
        !receipt ||
        workflow?.workflow !== expectedWorkflow(input.operationKind) ||
        !["pending", "executing", "returned"].includes(receipt.status) ||
        receipt.expiresAt.getTime() <= input.authorizedAt.getTime()
      ) {
        return "invalid-workflow";
      }
      const inserted = tx
        .insert(otaOperationWorkflows)
        .values({ ...input })
        .onConflictDoNothing()
        .run();
      return inserted.changes === 1 ? "authorized" : "conflict";
    });
  }

  async revoke(operationId: string): Promise<boolean> {
    return (
      this.db
        .delete(otaOperationWorkflows)
        .where(
          and(
            eq(otaOperationWorkflows.operationId, operationId),
            isNull(otaOperationWorkflows.deliveredAt),
          ),
        )
        .run().changes === 1
    );
  }

  async claimDelivery(input: {
    operationId: string;
    operationKind: OtaOperationKind;
    leaseId: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<OtaDeliveryClaim> {
    return this.immediate((tx) => {
      const row = tx
        .select()
        .from(otaOperationWorkflows)
        .where(eq(otaOperationWorkflows.operationId, input.operationId))
        .get();
      if (!row) return { kind: "not-found" };
      if (row.operationKind !== input.operationKind)
        return { kind: "invalid-route" };
      if (row.acknowledgedAt) return { kind: "acknowledged" };
      const workflowState = this.workflowState(tx, row, input.now);
      if (!workflowState) return { kind: "invalid-route" };
      if (row.deliveryLeaseUntil && row.deliveryLeaseUntil > input.now)
        return { kind: "busy" };
      if (row.deliveredAt) {
        const reclaimed = tx
          .update(otaOperationWorkflows)
          .set({
            deliveryLeaseId: input.leaseId,
            deliveryLeaseUntil: input.leaseUntil,
          })
          .where(
            and(
              eq(otaOperationWorkflows.operationId, input.operationId),
              isNull(otaOperationWorkflows.acknowledgedAt),
              or(
                isNull(otaOperationWorkflows.deliveryLeaseUntil),
                lt(otaOperationWorkflows.deliveryLeaseUntil, input.now),
              ),
            ),
          )
          .run();
        return reclaimed.changes === 1
          ? { kind: "delivered", route: route(row) }
          : { kind: "busy" };
      }
      const claimed = tx
        .update(otaOperationWorkflows)
        .set({
          deliveryLeaseId: input.leaseId,
          deliveryLeaseUntil: input.leaseUntil,
        })
        .where(
          and(
            eq(otaOperationWorkflows.operationId, input.operationId),
            isNull(otaOperationWorkflows.acknowledgedAt),
            isNull(otaOperationWorkflows.deliveredAt),
            or(
              isNull(otaOperationWorkflows.deliveryLeaseUntil),
              lt(otaOperationWorkflows.deliveryLeaseUntil, input.now),
            ),
          ),
        )
        .run();
      return claimed.changes === 1
        ? {
            kind:
              workflowState === "completed"
                ? "workflow-completed"
                : "claimed",
            route: route(row),
          }
        : { kind: "busy" };
    });
  }

  async markDelivered(input: {
    operationId: string;
    leaseId: string;
    deliveredAt: Date;
  }): Promise<boolean> {
    return (
      this.db
        .update(otaOperationWorkflows)
        .set({ deliveredAt: input.deliveredAt })
        .where(
          and(
            eq(otaOperationWorkflows.operationId, input.operationId),
            eq(otaOperationWorkflows.deliveryLeaseId, input.leaseId),
            isNull(otaOperationWorkflows.deliveredAt),
            isNull(otaOperationWorkflows.acknowledgedAt),
          ),
        )
        .run().changes === 1
    );
  }

  async acknowledge(input: {
    operationId: string;
    leaseId: string;
    acknowledgedAt: Date;
  }): Promise<boolean> {
    return (
      this.db
        .update(otaOperationWorkflows)
        .set({
          acknowledgedAt: input.acknowledgedAt,
          deliveryLeaseId: null,
          deliveryLeaseUntil: null,
        })
        .where(
          and(
            eq(otaOperationWorkflows.operationId, input.operationId),
            eq(otaOperationWorkflows.deliveryLeaseId, input.leaseId),
            isNull(otaOperationWorkflows.acknowledgedAt),
          ),
        )
        .run().changes === 1
    );
  }

  private workflowState(
    tx: Writer,
    row: RouteRow,
    now: Date,
  ): "active" | "completed" | null {
    const receipt = tx
      .select()
      .from(homeActionReceipts)
      .where(
        and(
          eq(homeActionReceipts.userId, row.userId),
          eq(homeActionReceipts.chatId, row.chatId),
          eq(homeActionReceipts.kind, "workflow-return"),
          eq(homeActionReceipts.id, row.workflowReceiptId),
        ),
      )
      .get();
    if (!receipt) return null;
    const workflow = decodeWorkflow(receipt.payload);
    if (
      workflow?.workflow !==
      expectedWorkflow(row.operationKind as OtaOperationKind)
    ) {
      return null;
    }
    if (
      ["pending", "executing", "returned"].includes(receipt.status) &&
      receipt.expiresAt > now
    ) {
      return "active";
    }
    if (
      receipt.status === "completed" &&
      [
        "direct-delivered",
        "notice-delivered",
        "restored",
        "delivered",
      ].includes(workflow.deliveryStage ?? "")
    ) {
      return "completed";
    }
    return null;
  }

  private immediate<T>(operation: (tx: Writer) => T): T {
    return this.db.transaction((tx) => operation(tx), {
      behavior: "immediate",
    });
  }
}
