import { LiveViewPolicyApplyError } from "./errors/live-view-policy-apply.error";
import { LiveViewSettingsStateError } from "./errors/live-view-settings-state.error";
import {
  createLiveViewSettingsCandidate,
  createLiveViewSettingsDocument,
  type LiveViewSettingsCandidate,
  type LiveViewSettingsDocument,
} from "./live-view-settings";

export type LiveViewPolicyRequestV1 =
  | {
      readonly version: 1;
      readonly kind: "settings-mutation";
      readonly requestId: string;
      readonly expectedGeneration: number;
      readonly rtspEnabled: boolean;
      readonly settings: LiveViewSettingsCandidate;
    }
  | {
      readonly version: 1;
      readonly kind: "rtsp-state-reconcile";
      readonly requestId: string;
      readonly expectedGeneration: number;
      readonly rtspEnabled: boolean;
    };

export interface LiveViewPolicyDocumentV2 {
  readonly version: 2;
  readonly settingsGeneration: number;
  readonly rtspEnabled: boolean;
  readonly workerUid: number;
  readonly streamUid: number;
  readonly allowedCidrs: readonly string[];
  readonly udpPortFirst: number;
  readonly udpPortLast: number;
}

export type LiveViewPolicyFailureCode =
  | "request-invalid"
  | "stale-generation"
  | "settings-state-unsafe"
  | "policy-apply-failed"
  | "service-unhealthy"
  | "rtsp-assets-absent"
  | "interrupted"
  | "helper-version-mismatch";

export interface LiveViewPolicyResultV1 {
  readonly version: 1;
  readonly kind: "settings-mutation" | "rtsp-state-reconcile";
  readonly requestId: string;
  readonly outcome: "succeeded" | "failed";
  readonly resultingGeneration: number | null;
  readonly resultingRtspEnabled: boolean | null;
  readonly failureCode: LiveViewPolicyFailureCode | null;
}

export type DerivedLiveViewPolicy = Pick<
  LiveViewPolicyDocumentV2,
  "version" | "settingsGeneration" | "rtspEnabled" | "allowedCidrs"
>;

const REQUEST_ID = /^[A-Za-z0-9_-]{16}$/;
const FAILURE_CODES: readonly LiveViewPolicyFailureCode[] = [
  "request-invalid",
  "stale-generation",
  "settings-state-unsafe",
  "policy-apply-failed",
  "service-unhealthy",
  "rtsp-assets-absent",
  "interrupted",
  "helper-version-mismatch",
];

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

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
}

function isFailureCode(value: unknown): value is LiveViewPolicyFailureCode {
  return (
    typeof value === "string" &&
    (FAILURE_CODES as readonly string[]).includes(value)
  );
}

export function deriveLiveViewPolicy(
  settings: LiveViewSettingsDocument,
  rtspEnabled: boolean,
): DerivedLiveViewPolicy {
  const committed = createLiveViewSettingsDocument(settings);
  if (typeof rtspEnabled !== "boolean") throw new LiveViewSettingsStateError();

  return {
    version: 2,
    settingsGeneration: committed.generation,
    rtspEnabled,
    allowedCidrs:
      committed.enabled && rtspEnabled ? committed.allowedCameraCidrs : [],
  };
}

export function createLiveViewPolicyRequestV1(
  value: unknown,
): LiveViewPolicyRequestV1 {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRequestId(value.requestId) ||
    !isSafeGeneration(value.expectedGeneration) ||
    typeof value.rtspEnabled !== "boolean"
  ) {
    throw new LiveViewSettingsStateError();
  }

  if (value.kind === "settings-mutation") {
    if (
      !hasExactKeys(value, [
        "version",
        "kind",
        "requestId",
        "expectedGeneration",
        "rtspEnabled",
        "settings",
      ])
    ) {
      throw new LiveViewSettingsStateError();
    }
    return {
      version: 1,
      kind: "settings-mutation",
      requestId: value.requestId,
      expectedGeneration: value.expectedGeneration,
      rtspEnabled: value.rtspEnabled,
      settings: createLiveViewSettingsCandidate(value.settings),
    };
  }

  if (
    value.kind === "rtsp-state-reconcile" &&
    hasExactKeys(value, [
      "version",
      "kind",
      "requestId",
      "expectedGeneration",
      "rtspEnabled",
    ])
  ) {
    return {
      version: 1,
      kind: "rtsp-state-reconcile",
      requestId: value.requestId,
      expectedGeneration: value.expectedGeneration,
      rtspEnabled: value.rtspEnabled,
    };
  }

  throw new LiveViewSettingsStateError();
}

export function createLiveViewPolicyResultV1(
  value: unknown,
): LiveViewPolicyResultV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "kind",
      "requestId",
      "outcome",
      "resultingGeneration",
      "resultingRtspEnabled",
      "failureCode",
    ]) ||
    value.version !== 1 ||
    (value.kind !== "settings-mutation" &&
      value.kind !== "rtsp-state-reconcile") ||
    !isRequestId(value.requestId)
  ) {
    throw new LiveViewPolicyApplyError();
  }

  if (
    value.outcome === "succeeded" &&
    isSafeGeneration(value.resultingGeneration) &&
    typeof value.resultingRtspEnabled === "boolean" &&
    value.failureCode === null
  ) {
    return {
      version: 1,
      kind: value.kind,
      requestId: value.requestId,
      outcome: "succeeded",
      resultingGeneration: value.resultingGeneration,
      resultingRtspEnabled: value.resultingRtspEnabled,
      failureCode: null,
    };
  }

  if (
    value.outcome === "failed" &&
    value.resultingGeneration === null &&
    value.resultingRtspEnabled === null &&
    isFailureCode(value.failureCode)
  ) {
    return {
      version: 1,
      kind: value.kind,
      requestId: value.requestId,
      outcome: "failed",
      resultingGeneration: null,
      resultingRtspEnabled: null,
      failureCode: value.failureCode,
    };
  }

  throw new LiveViewPolicyApplyError();
}
