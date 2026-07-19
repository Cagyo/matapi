import { Inject, Injectable } from "@nestjs/common";
import type { OtaFailure } from "../../system/domain/ota-contracts";
import { OTA, type OtaPort } from "../../system/domain/ports/ota.port";

export type RollbackLaunchOutcome =
  | { kind: "started"; operationId: string }
  | { kind: "failure"; failure: OtaFailure };

@Injectable()
export class RollbackSystemUseCase {
  constructor(@Inject(OTA) private readonly ota: OtaPort) {}

  async launch(input: {
    userId: number;
    chatId: number;
    workflowReceiptId: string;
  }): Promise<RollbackLaunchOutcome> {
    const started = await this.ota.startRollback({
      userId: input.userId,
      chatId: input.chatId,
      workflowReceiptId: input.workflowReceiptId,
    });
    if (started.kind === "rejected") {
      return { kind: "failure", failure: started.failure };
    }
    return { kind: "started", operationId: started.receipt.operationId };
  }
}
