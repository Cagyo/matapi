import type {
  CheckedReleaseIdentity,
  OtaOperationReceipt,
  ReserveOperationResult,
  StartOperationResult,
  UpdateCheck,
} from "../ota-contracts";

export const OTA = Symbol("OTA");

/** Signed-feed OTA facade used by interface contexts. */
export interface OtaPort {
  checkForUpdates(): Promise<UpdateCheck>;
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
