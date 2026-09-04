import { randomBytes } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { LiveViewPolicyApplyError } from "../domain/errors/live-view-policy-apply.error";
import {
  createLiveViewPolicyRequestV1,
  createLiveViewPolicyResultV1,
  type LiveViewPolicyFailureCode,
  type LiveViewPolicyResultV1,
} from "../domain/live-view-policy";
import {
  LIVE_VIEW_POLICY_ACKNOWLEDGEMENT,
  type LiveViewPolicyAcknowledgementPort,
} from "../domain/ports/live-view-policy-acknowledgement.port";
import {
  LIVE_VIEW_POLICY_CONTROLLER,
  type LiveViewPolicyControllerPort,
} from "../domain/ports/live-view-policy-controller.port";
import {
  LIVE_VIEW_POLICY_REQUEST,
  type LiveViewPolicyRequestPort,
} from "../domain/ports/live-view-policy-request.port";
import {
  LIVE_VIEW_POLICY_RESULT,
  type LiveViewPolicyResultPort,
} from "../domain/ports/live-view-policy-result.port";
import {
  LIVE_VIEW_SETTINGS_STORE,
  type LiveViewSettingsStorePort,
} from "../domain/ports/live-view-settings-store.port";

const DEFAULT_RESULT_POLL_INTERVAL_MS = 250;
const POLICY_APPLIER_TIMEOUT_MS = 60_000;
const ACTIVATION_AND_SCHEDULING_MARGIN_MS = 5_000;
const DEFAULT_MAX_RESULT_POLLS =
  (POLICY_APPLIER_TIMEOUT_MS - ACTIVATION_AND_SCHEDULING_MARGIN_MS) /
    DEFAULT_RESULT_POLL_INTERVAL_MS +
  1;

export const RECONCILE_RTSP_POLICY_OPTIONS = Symbol(
  "RECONCILE_RTSP_POLICY_OPTIONS",
);

export interface ReconcileRtspPolicyOptions {
  readonly requestId?: () => string;
  readonly maxResultPolls?: number;
  readonly resultPollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** The published policy request needs restart/boot recovery before another write. */
export class LiveViewPolicyRestartPendingError extends LiveViewPolicyApplyError {
  constructor() {
    super();
    this.name = "LiveViewPolicyRestartPendingError";
  }
}

/** Reconciles the root-owned RTSP policy to one exact committed-settings tuple. */
@Injectable()
export class ReconcileRtspPolicyUseCase {
  private readonly requestId: () => string;
  private readonly maxResultPolls: number;
  private readonly resultPollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    @Inject(LIVE_VIEW_SETTINGS_STORE)
    private readonly settings: LiveViewSettingsStorePort,
    @Inject(LIVE_VIEW_POLICY_REQUEST)
    private readonly requests: LiveViewPolicyRequestPort,
    @Inject(LIVE_VIEW_POLICY_CONTROLLER)
    private readonly controller: LiveViewPolicyControllerPort,
    @Inject(LIVE_VIEW_POLICY_RESULT)
    private readonly results: LiveViewPolicyResultPort,
    @Inject(LIVE_VIEW_POLICY_ACKNOWLEDGEMENT)
    private readonly acknowledgements: LiveViewPolicyAcknowledgementPort,
    @Optional()
    @Inject(RECONCILE_RTSP_POLICY_OPTIONS)
    options: ReconcileRtspPolicyOptions = {},
  ) {
    this.requestId = options.requestId ?? createRequestId;
    this.maxResultPolls = positiveInteger(
      options.maxResultPolls ?? DEFAULT_MAX_RESULT_POLLS,
      "RTSP policy result poll bound",
    );
    this.resultPollIntervalMs = positiveInteger(
      options.resultPollIntervalMs ?? DEFAULT_RESULT_POLL_INTERVAL_MS,
      "RTSP policy result poll interval",
    );
    this.sleep = options.sleep ?? sleep;
  }

  async execute(input: { readonly rtspEnabled: boolean }): Promise<void> {
    const committed = await this.settings.readCommitted();
    const request = createLiveViewPolicyRequestV1({
      version: 1,
      kind: "rtsp-state-reconcile",
      requestId: this.requestId(),
      expectedGeneration: committed.generation,
      rtspEnabled: input.rtspEnabled,
    });

    let terminal: LiveViewPolicyResultV1;
    try {
      await this.requests.publish(request);
      await this.controller.start();
      const result = await this.pollResult(request.requestId);
      terminal = createLiveViewPolicyResultV1(result);

      if (
        terminal.kind !== request.kind ||
        terminal.requestId !== request.requestId
      ) {
        throw new LiveViewPolicyApplyError();
      }

      if (
        terminal.outcome === "succeeded" &&
        (terminal.resultingGeneration !== committed.generation ||
          terminal.resultingRtspEnabled !== request.rtspEnabled)
      ) {
        throw new LiveViewPolicyApplyError();
      }

      await this.acknowledgements.publish(request.requestId);
    } catch {
      throw new LiveViewPolicyRestartPendingError();
    }

    await this.controller.start().catch(() => undefined);
    if (terminal.outcome === "failed") {
      if (terminal.failureCode === null) throw new LiveViewPolicyApplyError();
      throw mapFailure(terminal.failureCode);
    }
  }

  private async pollResult(requestId: string): Promise<LiveViewPolicyResultV1> {
    for (let attempt = 0; attempt < this.maxResultPolls; attempt += 1) {
      const result = await this.results.read(requestId);
      if (result !== null) return result;
      if (attempt + 1 < this.maxResultPolls) {
        await this.sleep(this.resultPollIntervalMs);
      }
    }
    throw new LiveViewPolicyApplyError();
  }
}

function createRequestId(): string {
  return randomBytes(12).toString("base64url");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mapFailure(
  failureCode: LiveViewPolicyFailureCode,
): LiveViewPolicyApplyError {
  switch (failureCode) {
    case "request-invalid":
    case "stale-generation":
    case "settings-state-unsafe":
    case "policy-apply-failed":
    case "service-unhealthy":
    case "rtsp-assets-absent":
    case "interrupted":
    case "helper-version-mismatch":
      return new LiveViewPolicyApplyError();
  }
}
