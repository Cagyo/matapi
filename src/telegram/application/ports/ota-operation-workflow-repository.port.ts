export const OTA_OPERATION_WORKFLOW_REPOSITORY = Symbol(
  "OTA_OPERATION_WORKFLOW_REPOSITORY",
);

export type OtaWorkflow = "ota-update" | "ota-rollback";
export type OtaOperationKind = "update" | "rollback";

export interface OtaOperationRoute {
  operationId: string;
  operationKind: OtaOperationKind;
  userId: number;
  chatId: number;
  workflowReceiptId: string;
  workflow: OtaWorkflow;
}

export type OtaDeliveryClaim =
  | { kind: "claimed"; route: OtaOperationRoute }
  | { kind: "delivered"; route: OtaOperationRoute }
  | { kind: "acknowledged" | "busy" | "not-found" | "invalid-route" };

export interface OtaOperationWorkflowRepositoryPort {
  authorize(input: {
    operationId: string;
    operationKind: OtaOperationKind;
    userId: number;
    chatId: number;
    workflowReceiptId: string;
    authorizedAt: Date;
  }): Promise<"authorized" | "invalid-workflow" | "conflict">;
  revoke(operationId: string): Promise<boolean>;
  claimDelivery(input: {
    operationId: string;
    operationKind: OtaOperationKind;
    leaseId: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<OtaDeliveryClaim>;
  markDelivered(input: {
    operationId: string;
    leaseId: string;
    deliveredAt: Date;
  }): Promise<boolean>;
  acknowledge(input: {
    operationId: string;
    leaseId: string;
    acknowledgedAt: Date;
  }): Promise<boolean>;
}
