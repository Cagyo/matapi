import type { UpdateTargetName } from "../ota-contracts";
import type { OtaFailureCode } from "../ota-failure";

export const OTA_ADMIN_NOTIFICATIONS = Symbol("OTA_ADMIN_NOTIFICATIONS");

export type OtaAdminNotice =
  | {
      kind: "release-available";
      version: string;
      targetName: UpdateTargetName;
      commit: string;
    }
  | { kind: "discovery-failure"; code: OtaFailureCode };

export interface OtaAdminNotificationPort {
  deliver(notice: OtaAdminNotice): Promise<{ delivered: number }>;
}
