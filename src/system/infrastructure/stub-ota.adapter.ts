import { Injectable } from "@nestjs/common";
import type {
  CheckedReleaseIdentity,
  OtaOperationReceipt,
  ReserveOperationResult,
  StartOperationResult,
  UpdateCheck,
} from "../domain/ota-contracts";
import type { OtaPort } from "../domain/ports/ota.port";

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

  reserveUpdate(
    _expected: CheckedReleaseIdentity,
    _signal?: AbortSignal,
  ): Promise<ReserveOperationResult> {
    return Promise.resolve(REJECTED);
  }

  reserveRollback(_signal?: AbortSignal): Promise<ReserveOperationResult> {
    return Promise.resolve(REJECTED);
  }

  publish(
    _receipt: OtaOperationReceipt,
    _signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    return Promise.resolve(REJECTED);
  }

  cancel(_receipt: OtaOperationReceipt): Promise<boolean> {
    return Promise.resolve(false);
  }
}
