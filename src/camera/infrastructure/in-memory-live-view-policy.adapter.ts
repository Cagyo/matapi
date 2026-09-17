import { LiveViewPolicyApplyError } from "../domain/errors/live-view-policy-apply.error";
import {
  createLiveViewPolicyRequestV1,
  createLiveViewPolicyResultV1,
  type LiveViewPolicyRequestV1,
  type LiveViewPolicyResultV1,
} from "../domain/live-view-policy";
import { nextLiveViewSettings } from "../domain/live-view-settings";
import type { LiveViewPolicyAcknowledgementPort } from "../domain/ports/live-view-policy-acknowledgement.port";
import type { LiveViewPolicyControllerPort } from "../domain/ports/live-view-policy-controller.port";
import type { LiveViewPolicyRequestPort } from "../domain/ports/live-view-policy-request.port";
import type { LiveViewPolicyResultPort } from "../domain/ports/live-view-policy-result.port";
import { InMemoryLiveViewSettingsAdapter } from "./in-memory-live-view-settings.adapter";

export type InMemoryLiveViewPolicyPausePoint =
  | "policy-rename"
  | "settings-rename"
  | "result-rename";

export interface InMemoryLiveViewPolicySnapshot {
  readonly request: LiveViewPolicyRequestV1 | null;
  readonly result: LiveViewPolicyResultV1 | null;
  readonly acknowledgedRequestId: string | null;
  readonly settingsCommitCount: number;
  readonly resultWriteCount: number;
}

/** Deterministic root-helper model used by phase and crash-table tests. */
export class InMemoryLiveViewPolicyAdapter
  implements
    LiveViewPolicyRequestPort,
    LiveViewPolicyResultPort,
    LiveViewPolicyAcknowledgementPort,
    LiveViewPolicyControllerPort
{
  private request: LiveViewPolicyRequestV1 | null = null;
  private result: LiveViewPolicyResultV1 | null = null;
  private acknowledgedRequestId: string | null = null;
  private pausePoint: InMemoryLiveViewPolicyPausePoint | null = null;
  private settingsCommitCount = 0;
  private resultWriteCount = 0;

  constructor(private readonly settings: InMemoryLiveViewSettingsAdapter) {}

  publish(
    request: LiveViewPolicyRequestV1,
  ): Promise<"published" | "already-published">;
  publish(requestId: string): Promise<"published" | "already-published">;
  async publish(
    value: LiveViewPolicyRequestV1 | string,
  ): Promise<"published" | "already-published"> {
    if (typeof value === "string") return this.publishAcknowledgement(value);

    const canonical = createLiveViewPolicyRequestV1(value);
    if (this.request !== null) {
      if (!sameRequest(this.request, canonical)) {
        throw new LiveViewPolicyApplyError();
      }
      return "already-published";
    }
    this.request = canonical;
    return "published";
  }

  async publishAcknowledgement(
    requestId: string,
  ): Promise<"published" | "already-published"> {
    if (this.result?.requestId !== requestId) {
      throw new LiveViewPolicyApplyError();
    }
    if (this.acknowledgedRequestId !== null) {
      if (this.acknowledgedRequestId !== requestId) {
        throw new LiveViewPolicyApplyError();
      }
      return "already-published";
    }
    this.acknowledgedRequestId = requestId;
    return "published";
  }

  async read(requestId: string): Promise<LiveViewPolicyResultV1 | null> {
    if (this.result?.requestId !== requestId) return null;
    return createLiveViewPolicyResultV1(this.result);
  }

  async start(): Promise<void> {
    if (this.acknowledgedRequestId !== null) {
      this.request = null;
      this.result = null;
      this.acknowledgedRequestId = null;
      return;
    }
    if (this.result !== null || this.request === null) return;

    if (this.request.kind === "settings-mutation") {
      await this.applySettingsMutation(this.request);
      return;
    }
    await this.applyRtspReconciliation(this.request);
  }

  pauseAfter(point: InMemoryLiveViewPolicyPausePoint): void {
    this.pausePoint = point;
  }

  snapshot(): InMemoryLiveViewPolicySnapshot {
    return {
      request: this.request
        ? createLiveViewPolicyRequestV1(this.request)
        : null,
      result: this.result ? createLiveViewPolicyResultV1(this.result) : null,
      acknowledgedRequestId: this.acknowledgedRequestId,
      settingsCommitCount: this.settingsCommitCount,
      resultWriteCount: this.resultWriteCount,
    };
  }

  private async applySettingsMutation(
    request: Extract<LiveViewPolicyRequestV1, { kind: "settings-mutation" }>,
  ): Promise<void> {
    const current = await this.settings.readCommitted();
    const target = nextLiveViewSettings(
      {
        version: 1,
        generation: request.expectedGeneration,
        enabled: current.enabled,
        allowedCameraCidrs: current.allowedCameraCidrs,
      },
      request.settings,
    );

    if (current.generation === request.expectedGeneration) {
      if (this.consumePause("policy-rename")) return;
      this.settings.setCommitted(target);
      this.settingsCommitCount += 1;
      if (this.consumePause("settings-rename")) return;
    } else if (!sameSettings(current, target)) {
      this.writeResult({
        version: 1,
        kind: request.kind,
        requestId: request.requestId,
        outcome: "failed",
        resultingGeneration: null,
        resultingRtspEnabled: null,
        failureCode: "stale-generation",
      });
      return;
    }

    this.writeResult({
      version: 1,
      kind: request.kind,
      requestId: request.requestId,
      outcome: "succeeded",
      resultingGeneration: request.expectedGeneration + 1,
      resultingRtspEnabled: request.rtspEnabled,
      failureCode: null,
    });
  }

  private async applyRtspReconciliation(
    request: Extract<LiveViewPolicyRequestV1, { kind: "rtsp-state-reconcile" }>,
  ): Promise<void> {
    const current = await this.settings.readCommitted();
    if (current.generation !== request.expectedGeneration) {
      this.writeResult({
        version: 1,
        kind: request.kind,
        requestId: request.requestId,
        outcome: "failed",
        resultingGeneration: null,
        resultingRtspEnabled: null,
        failureCode: "stale-generation",
      });
      return;
    }
    if (this.consumePause("policy-rename")) return;
    this.writeResult({
      version: 1,
      kind: request.kind,
      requestId: request.requestId,
      outcome: "succeeded",
      resultingGeneration: current.generation,
      resultingRtspEnabled: request.rtspEnabled,
      failureCode: null,
    });
  }

  private writeResult(value: LiveViewPolicyResultV1): void {
    if (this.result === null) {
      this.result = createLiveViewPolicyResultV1(value);
      this.resultWriteCount += 1;
    }
    this.consumePause("result-rename");
  }

  private consumePause(point: InMemoryLiveViewPolicyPausePoint): boolean {
    if (this.pausePoint !== point) return false;
    this.pausePoint = null;
    return true;
  }
}

function sameRequest(
  left: LiveViewPolicyRequestV1,
  right: LiveViewPolicyRequestV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSettings(
  left: {
    readonly version: 1;
    readonly generation: number;
    readonly enabled: boolean;
    readonly allowedCameraCidrs: readonly string[];
  },
  right: {
    readonly version: 1;
    readonly generation: number;
    readonly enabled: boolean;
    readonly allowedCameraCidrs: readonly string[];
  },
): boolean {
  return (
    left.generation === right.generation &&
    left.enabled === right.enabled &&
    left.allowedCameraCidrs.length === right.allowedCameraCidrs.length &&
    left.allowedCameraCidrs.every(
      (value, index) => value === right.allowedCameraCidrs[index],
    )
  );
}
