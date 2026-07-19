import { Inject, Injectable } from "@nestjs/common";
import { CheckForUpdatesUseCase } from "../application/check-for-updates.use-case";
import type {
  CheckedReleaseIdentity,
  OtaOperationReceipt,
  ReserveOperationResult,
  StartOperationResult,
  UpdateCheck,
} from "../domain/ota-contracts";
import {
  OTA_OPERATION_LAUNCHER,
  type OtaOperationLauncherPort,
} from "../domain/ports/ota-operation-launcher.port";
import type { OtaPort } from "../domain/ports/ota.port";

/** Keeps signed discovery and exact-identity operation launch behind one port. */
@Injectable()
export class SignedFeedOtaAdapter implements OtaPort {
  constructor(
    private readonly checks: CheckForUpdatesUseCase,
    @Inject(OTA_OPERATION_LAUNCHER)
    private readonly launcher: OtaOperationLauncherPort,
  ) {}

  checkForUpdates(): Promise<UpdateCheck> {
    return this.checks.execute();
  }

  reserveUpdate(
    expected: CheckedReleaseIdentity,
    signal?: AbortSignal,
  ): Promise<ReserveOperationResult> {
    return this.launcher.reserveUpdate(expected, signal);
  }

  reserveRollback(signal?: AbortSignal): Promise<ReserveOperationResult> {
    return this.launcher.reserveRollback(signal);
  }

  publish(
    receipt: OtaOperationReceipt,
    signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    return this.launcher.publish(receipt, signal);
  }

  cancel(receipt: OtaOperationReceipt): Promise<boolean> {
    return this.launcher.cancel(receipt);
  }
}
