import { Injectable } from "@nestjs/common";
import type {
  CheckedReleaseIdentity,
  OtaOperationReceipt,
  ReserveOperationResult,
  StartOperationResult,
} from "../domain/ota-contracts";
import type { OtaOperationLauncherPort } from "../domain/ports/ota-operation-launcher.port";

const MAINTENANCE_REJECTION: StartOperationResult = Object.freeze({
  kind: "rejected",
  failure: Object.freeze({ code: "maintenance-required" }),
});

const MAINTENANCE_RESERVATION_REJECTION: ReserveOperationResult =
  MAINTENANCE_REJECTION;

@Injectable()
export class StubOtaOperationLauncherAdapter implements OtaOperationLauncherPort {
  reserveUpdate(
    _expected: CheckedReleaseIdentity,
    _signal?: AbortSignal,
  ): Promise<ReserveOperationResult> {
    return Promise.resolve(MAINTENANCE_RESERVATION_REJECTION);
  }

  reserveRollback(_signal?: AbortSignal): Promise<ReserveOperationResult> {
    return Promise.resolve(MAINTENANCE_RESERVATION_REJECTION);
  }

  publish(
    _receipt: OtaOperationReceipt,
    _signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    return Promise.resolve(MAINTENANCE_REJECTION);
  }

  cancel(_receipt: OtaOperationReceipt): Promise<boolean> {
    return Promise.resolve(false);
  }

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
