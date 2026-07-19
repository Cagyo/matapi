import { Injectable } from "@nestjs/common";
import type {
  OtaWorkflowBindingPort,
  OtaWorkflowBindingRequest,
} from "./ports/ota-workflow-binding.port";

/** Fail-closed registration seam; Telegram supplies durable workflow binding. */
@Injectable()
export class OtaWorkflowBindingRegistry implements OtaWorkflowBindingPort {
  private delegate?: OtaWorkflowBindingPort;

  register(delegate: OtaWorkflowBindingPort): void {
    this.delegate = delegate;
  }

  clear(delegate: OtaWorkflowBindingPort): void {
    if (this.delegate === delegate) this.delegate = undefined;
  }

  bind(request: OtaWorkflowBindingRequest): Promise<boolean> {
    return this.delegate?.bind(request) ?? Promise.resolve(false);
  }
}
