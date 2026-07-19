import { Injectable } from "@nestjs/common";
import type {
  CheckedReleaseIdentity,
  StartOperationResult,
  UpdateCheck,
} from "../domain/ota-contracts";
import type { OtaPort, OtaWorkflowReference } from "../domain/ports/ota.port";

const REJECTED = Object.freeze({
  kind: "rejected" as const,
  failure: Object.freeze({ code: "maintenance-required" as const }),
});

/** Safe local-mode facade: discovery and mutation are both non-operational. */
@Injectable()
export class StubOtaAdapter implements OtaPort {
  checkForUpdates(): Promise<UpdateCheck> {
    return Promise.resolve({
      kind: "failure",
      failure: { code: "maintenance-required" },
    });
  }

  startUpdate(
    _expected: CheckedReleaseIdentity,
    _workflow: OtaWorkflowReference,
    _signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    return Promise.resolve(REJECTED);
  }

  startRollback(
    _workflow: OtaWorkflowReference,
    _signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    return Promise.resolve(REJECTED);
  }
}
