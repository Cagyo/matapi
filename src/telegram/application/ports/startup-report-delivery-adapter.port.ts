import type { StartupReportDeliveryPort } from "../../../system/application/consume-startup-report.use-case";
import type { WorkflowEntryCoordinator } from "../../interfaces/workflow-entry.coordinator";

export const TELEGRAM_STARTUP_REPORT_DELIVERY = Symbol(
  "TELEGRAM_STARTUP_REPORT_DELIVERY",
);

export type TelegramStartupReportDeliveryPort = StartupReportDeliveryPort;

export const OTA_WORKFLOW_COMPLETION = Symbol("OTA_WORKFLOW_COMPLETION");
export type OtaWorkflowCompletionPort = Pick<
  WorkflowEntryCoordinator,
  "completeHeadless"
>;
