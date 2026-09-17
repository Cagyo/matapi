import { LiveViewSettingsBusyError } from "./errors/live-view-settings-busy.error";
import { LiveViewSettingsStateError } from "./errors/live-view-settings-state.error";
import type { LiveViewPolicyFailureCode } from "./live-view-policy";
import {
  createLiveViewSettingsCandidate,
  type LiveViewSettingsCandidate,
} from "./live-view-settings";

export type LiveViewSettingsJobStatus =
  | "prepared"
  | "published"
  | "committed"
  | "restart-required"
  | "succeeded"
  | "failed";

export type LiveViewSettingsJobFailureCode =
  | LiveViewPolicyFailureCode
  | "live-work-not-quiescent"
  | "request-publish-failed"
  | "unit-start-failed"
  | "restart-dispatch-failed"
  | "restart-activation-timeout"
  | "dependency-unready";

export interface LiveViewSettingsJob {
  readonly id: string;
  readonly requestedByUserId: number;
  readonly requestedInChatId: number;
  readonly workflowReceiptId: string;
  readonly status: LiveViewSettingsJobStatus;
  readonly activeSlot: 1 | null;
  readonly expectedGeneration: number;
  readonly candidateSettings: LiveViewSettingsCandidate;
  readonly failureCode: LiveViewSettingsJobFailureCode | null;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{16}$/;
const ACTIVE_STATUSES: readonly LiveViewSettingsJobStatus[] = [
  "prepared",
  "published",
  "committed",
  "restart-required",
];
const FAILURE_CODES: readonly LiveViewSettingsJobFailureCode[] = [
  "request-invalid",
  "stale-generation",
  "settings-state-unsafe",
  "policy-apply-failed",
  "service-unhealthy",
  "rtsp-assets-absent",
  "interrupted",
  "helper-version-mismatch",
  "live-work-not-quiescent",
  "request-publish-failed",
  "unit-start-failed",
  "restart-dispatch-failed",
  "restart-activation-timeout",
  "dependency-unready",
];
const RESTART_REQUIRED_FAILURE_CODES: readonly LiveViewSettingsJobFailureCode[] = [
  "restart-dispatch-failed",
  "restart-activation-timeout",
];

const TRANSITIONS: Readonly<
  Record<LiveViewSettingsJobStatus, readonly LiveViewSettingsJobStatus[]>
> = {
  prepared: ["published", "failed"],
  published: ["committed", "failed"],
  committed: ["restart-required", "succeeded", "failed"],
  "restart-required": ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isSafeGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStatus(value: unknown): value is LiveViewSettingsJobStatus {
  return typeof value === "string" && Object.hasOwn(TRANSITIONS, value);
}

function isFailureCode(
  value: unknown,
): value is LiveViewSettingsJobFailureCode {
  return (
    typeof value === "string" &&
    (FAILURE_CODES as readonly string[]).includes(value)
  );
}

function activeSlotFor(status: LiveViewSettingsJobStatus): 1 | null {
  return (ACTIVE_STATUSES as readonly string[]).includes(status) ? 1 : null;
}

export function createLiveViewSettingsJob(value: unknown): LiveViewSettingsJob {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "requestedByUserId",
      "requestedInChatId",
      "workflowReceiptId",
      "status",
      "expectedGeneration",
      "candidateSettings",
      "failureCode",
    ]) ||
    typeof value.id !== "string" ||
    !REQUEST_ID.test(value.id) ||
    typeof value.requestedByUserId !== "number" || !Number.isSafeInteger(value.requestedByUserId) ||
    typeof value.requestedInChatId !== "number" || !Number.isSafeInteger(value.requestedInChatId) ||
    typeof value.workflowReceiptId !== "string" || !REQUEST_ID.test(value.workflowReceiptId) ||
    !isStatus(value.status) ||
    !isSafeGeneration(value.expectedGeneration)
  ) {
    throw new LiveViewSettingsStateError();
  }

  let failureCode: LiveViewSettingsJobFailureCode | null;
  if (value.status === "failed") {
    if (!isFailureCode(value.failureCode))
      throw new LiveViewSettingsStateError();
    failureCode = value.failureCode;
  } else if (value.status === "restart-required") {
    if (
      !isFailureCode(value.failureCode) ||
      !RESTART_REQUIRED_FAILURE_CODES.includes(value.failureCode)
    ) {
      throw new LiveViewSettingsStateError();
    }
    failureCode = value.failureCode;
  } else {
    if (value.failureCode !== null) throw new LiveViewSettingsStateError();
    failureCode = null;
  }

  return {
    id: value.id,
    requestedByUserId: value.requestedByUserId,
    requestedInChatId: value.requestedInChatId,
    workflowReceiptId: value.workflowReceiptId,
    status: value.status,
    activeSlot: activeSlotFor(value.status),
    expectedGeneration: value.expectedGeneration,
    candidateSettings: createLiveViewSettingsCandidate(value.candidateSettings),
    failureCode,
  };
}

export function canTransitionLiveViewSettingsJob(
  from: LiveViewSettingsJobStatus,
  to: LiveViewSettingsJobStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionLiveViewSettingsJob(
  current: LiveViewSettingsJob,
  status: LiveViewSettingsJobStatus,
  failureCode: LiveViewSettingsJobFailureCode | null = null,
): LiveViewSettingsJob {
  if (current.status === status && current.activeSlot === 1)
    throw new LiveViewSettingsBusyError();
  if (!canTransitionLiveViewSettingsJob(current.status, status))
    throw new LiveViewSettingsStateError();

  return createLiveViewSettingsJob({
    id: current.id,
    requestedByUserId: current.requestedByUserId,
    requestedInChatId: current.requestedInChatId,
    workflowReceiptId: current.workflowReceiptId,
    status,
    expectedGeneration: current.expectedGeneration,
    candidateSettings: current.candidateSettings,
    failureCode:
      status === "failed" || status === "restart-required"
        ? failureCode
        : null,
  });
}
