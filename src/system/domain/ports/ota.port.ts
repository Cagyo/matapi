import type {
  CheckedReleaseIdentity,
  StartOperationResult,
  UpdateCheck,
} from "../ota-contracts";

export const OTA = Symbol("OTA");

export interface OtaWorkflowReference {
  userId: number;
  chatId: number;
  workflowReceiptId: string;
}

/** Signed-feed OTA facade used by interface contexts. */
export interface OtaPort {
  checkForUpdates(): Promise<UpdateCheck>;
  startUpdate(
    expected: CheckedReleaseIdentity,
    workflow: OtaWorkflowReference,
    signal?: AbortSignal,
  ): Promise<StartOperationResult>;
  startRollback(
    workflow: OtaWorkflowReference,
    signal?: AbortSignal,
  ): Promise<StartOperationResult>;
}
