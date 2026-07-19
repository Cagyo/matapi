import type {
  CheckedReleaseIdentity,
  OtaOperationReceipt,
  ReserveOperationResult,
  StartOperationResult,
} from "../ota-contracts";

export const OTA_OPERATION_LAUNCHER = Symbol("OTA_OPERATION_LAUNCHER");

export interface OtaOperationLauncherPort {
  reserveUpdate(
    expected: CheckedReleaseIdentity,
    signal?: AbortSignal,
  ): Promise<ReserveOperationResult>;
  reserveRollback(signal?: AbortSignal): Promise<ReserveOperationResult>;
  publish(
    receipt: OtaOperationReceipt,
    signal?: AbortSignal,
  ): Promise<StartOperationResult>;
  cancel(receipt: OtaOperationReceipt): Promise<boolean>;
}
