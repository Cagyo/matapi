import { Injectable } from "@nestjs/common";
import type {
  CheckedReleaseIdentity,
  StartOperationResult,
} from "../domain/ota-contracts";
import type { OtaOperationLauncherPort } from "../domain/ports/ota-operation-launcher.port";

const MAINTENANCE_REJECTION: StartOperationResult = Object.freeze({
  kind: "rejected",
  failure: Object.freeze({ code: "maintenance-required" }),
});

@Injectable()
export class StubOtaOperationLauncherAdapter implements OtaOperationLauncherPort {
  startUpdate(
    _expected: CheckedReleaseIdentity,
    _signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    return Promise.resolve(MAINTENANCE_REJECTION);
  }

  startRollback(_signal?: AbortSignal): Promise<StartOperationResult> {
    return Promise.resolve(MAINTENANCE_REJECTION);
  }
}
