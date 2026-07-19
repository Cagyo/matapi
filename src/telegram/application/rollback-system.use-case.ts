import { Inject, Injectable } from "@nestjs/common";
import type { OtaFailure } from "../../system/domain/ota-contracts";
import { OTA, type OtaPort } from "../../system/domain/ports/ota.port";
import {
  OTA_OPERATION_WORKFLOW_REPOSITORY,
  type OtaOperationWorkflowRepositoryPort,
} from "./ports/ota-operation-workflow-repository.port";

export type RollbackLaunchOutcome =
  | { kind: "started"; operationId: string }
  | { kind: "failure"; failure: OtaFailure };

@Injectable()
export class RollbackSystemUseCase {
  constructor(
    @Inject(OTA) private readonly ota: OtaPort,
    @Inject(OTA_OPERATION_WORKFLOW_REPOSITORY)
    private readonly routes: OtaOperationWorkflowRepositoryPort,
  ) {}

  async launch(input: {
    userId: number;
    chatId: number;
    workflowReceiptId: string;
  }): Promise<RollbackLaunchOutcome> {
    const reserved = await this.ota.reserveRollback();
    if (reserved.kind === "rejected") {
      return { kind: "failure", failure: reserved.failure };
    }
    const operationId = reserved.receipt.operationId;
    const authorization = await this.routes.authorize({
      operationId,
      operationKind: "rollback",
      userId: input.userId,
      chatId: input.chatId,
      workflowReceiptId: input.workflowReceiptId,
      authorizedAt: new Date(reserved.receipt.acceptedAt),
    });
    if (authorization !== "authorized") {
      await this.ota.cancel(reserved.receipt);
      return { kind: "failure", failure: { code: "maintenance-required" } };
    }
    try {
      const started = await this.ota.publish(reserved.receipt);
      if (started.kind === "rejected") {
        await this.routes.revoke(operationId);
        return { kind: "failure", failure: started.failure };
      }
      return { kind: "started", operationId };
    } catch {
      await this.routes.revoke(operationId);
      await this.ota.cancel(reserved.receipt);
      return { kind: "failure", failure: { code: "maintenance-required" } };
    }
  }
}
