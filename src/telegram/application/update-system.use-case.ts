import { Inject, Injectable } from "@nestjs/common";
import type {
  CheckedReleaseIdentity,
  OtaFailure,
  UpdateCheck,
} from "../../system/domain/ota-contracts";
import { OTA, type OtaPort } from "../../system/domain/ports/ota.port";

export type UpdateInspection = UpdateCheck;
export type UpdateLaunchOutcome =
  | { kind: "started"; commit: string; operationId: string }
  | { kind: "failure"; failure: OtaFailure };

export interface UpdateLaunchInput {
  checked: CheckedReleaseIdentity;
  userId: number;
  chatId: number;
  workflowReceiptId: string;
}

@Injectable()
export class UpdateSystemUseCase {
  constructor(@Inject(OTA) private readonly ota: OtaPort) {}

  check(): Promise<UpdateInspection> {
    return this.ota.checkForUpdates();
  }

  async launch(input: UpdateLaunchInput): Promise<UpdateLaunchOutcome> {
    const started = await this.ota.startUpdate(input.checked, {
      userId: input.userId,
      chatId: input.chatId,
      workflowReceiptId: input.workflowReceiptId,
    });
    if (started.kind === "rejected") {
      return { kind: "failure", failure: started.failure };
    }
    return {
      kind: "started",
      commit: input.checked.artifact.commit,
      operationId: started.receipt.operationId,
    };
  }
}
