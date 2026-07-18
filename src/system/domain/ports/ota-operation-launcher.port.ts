import type {
  CheckedReleaseIdentity,
  StartOperationResult,
} from "../ota-contracts";

export const OTA_OPERATION_LAUNCHER = Symbol("OTA_OPERATION_LAUNCHER");

export interface OtaOperationLauncherPort {
  startUpdate(
    expected: CheckedReleaseIdentity,
    signal?: AbortSignal,
  ): Promise<StartOperationResult>;
  startRollback(signal?: AbortSignal): Promise<StartOperationResult>;
}
