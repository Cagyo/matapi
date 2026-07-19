import type { OtaOperationReceipt } from "../../domain/ota-contracts";
import type { OtaWorkflowReference } from "../../domain/ports/ota.port";

export interface OtaWorkflowBindingRequest {
  receipt: OtaOperationReceipt;
  workflow: OtaWorkflowReference;
}

export interface OtaWorkflowBindingPort {
  bind(request: OtaWorkflowBindingRequest): Promise<boolean>;
}
