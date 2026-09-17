import { Inject, Injectable, Optional } from "@nestjs/common";

import {
  FEATURE_QUERY,
  type FeatureQueryPort,
} from "../../features/domain/ports/feature-query.port";
import {
  PROCESS_RESTARTER,
  type ProcessRestarterPort,
} from "../../system/domain/ports/process-restarter.port";
import { LiveViewPolicyApplyError } from "../domain/errors/live-view-policy-apply.error";
import {
  createLiveViewPolicyRequestV1,
  createLiveViewPolicyResultV1,
  type LiveViewPolicyResultV1,
} from "../domain/live-view-policy";
import type {
  LiveViewSettingsJob,
  LiveViewSettingsJobFailureCode,
} from "../domain/live-view-settings-job";
import type { LiveViewSettingsDocument } from "../domain/live-view-settings";
import {
  CAMERA_CLOCK,
  type CameraClockPort,
} from "../domain/ports/camera-clock.port";
import {
  LIVE_STREAM_CAPABILITY,
  type LiveStreamCapabilityPort,
} from "../domain/ports/live-stream-capability.port";
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
  LIVE_VIEW_SETTINGS_JOB_REPOSITORY,
  type LiveViewSettingsJobRepositoryPort,
} from "../domain/ports/live-view-settings-job-repository.port";
import {
  LIVE_VIEW_SETTINGS_STORE,
  type LiveViewSettingsStorePort,
} from "../domain/ports/live-view-settings-store.port";
import { LiveStreamSessionService } from "./live-stream-session.service";
import { LiveViewRestartActivationService } from "./live-view-restart-activation.service";
import {
  LiveViewPolicyCoordinatorService,
  type LiveViewPolicyMutationLease,
} from "./live-view-policy-coordinator.service";
import { LiveViewStartGate } from "./live-view-start-gate.service";
import { LiveViewSettingsOutcomeRegistryService } from './live-view-settings-outcome-registry.service';

const DEFAULT_RESULT_POLL_INTERVAL_MS = 250;
const POLICY_APPLIER_TIMEOUT_MS = 60_000;
const ACTIVATION_AND_SCHEDULING_MARGIN_MS = 5_000;
const DEFAULT_MAX_RESULT_POLLS =
  (POLICY_APPLIER_TIMEOUT_MS + ACTIVATION_AND_SCHEDULING_MARGIN_MS) /
    DEFAULT_RESULT_POLL_INTERVAL_MS +
  1;

export const RECONCILE_LIVE_VIEW_SETTINGS_JOB_OPTIONS = Symbol(
  "RECONCILE_LIVE_VIEW_SETTINGS_JOB_OPTIONS",
);

export interface ReconcileLiveViewSettingsJobOptions {
  readonly maxResultPolls?: number;
  readonly resultPollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type ReconcileLiveViewSettingsJobResult =
  | { readonly kind: "resumed" }
  | { readonly kind: "pending" }
  | { readonly kind: "restart-required" }
  | { readonly kind: "succeeded" }
  | {
      readonly kind: "failed";
      readonly failureCode: LiveViewSettingsJobFailureCode;
    };

interface PolicyState {
  readonly rtspEnabled: boolean;
}

/** Resumes one durable settings mutation from its last committed job phase. */
@Injectable()
export class ReconcileLiveViewSettingsJobUseCase {
  private readonly maxResultPolls: number;
  private readonly resultPollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    @Inject(LIVE_VIEW_SETTINGS_JOB_REPOSITORY)
    private readonly jobs: LiveViewSettingsJobRepositoryPort,
    @Inject(LIVE_VIEW_SETTINGS_STORE)
    private readonly settings: LiveViewSettingsStorePort,
    @Inject(FEATURE_QUERY)
    private readonly features: FeatureQueryPort,
    private readonly gate: LiveViewStartGate,
    @Inject(LiveStreamSessionService)
    private readonly sessions: Pick<LiveStreamSessionService, "quiesce">,
    private readonly coordinator: LiveViewPolicyCoordinatorService,
    @Inject(LIVE_VIEW_POLICY_REQUEST)
    private readonly requests: LiveViewPolicyRequestPort,
    @Inject(LIVE_VIEW_POLICY_CONTROLLER)
    private readonly controller: LiveViewPolicyControllerPort,
    @Inject(LIVE_VIEW_POLICY_RESULT)
    private readonly results: LiveViewPolicyResultPort,
    @Inject(LIVE_VIEW_POLICY_ACKNOWLEDGEMENT)
    private readonly acknowledgements: LiveViewPolicyAcknowledgementPort,
    @Inject(PROCESS_RESTARTER)
    private readonly restarter: ProcessRestarterPort,
    @Inject(LIVE_STREAM_CAPABILITY)
    private readonly capability: LiveStreamCapabilityPort,
    @Inject(CAMERA_CLOCK)
    private readonly clock: CameraClockPort,
    @Optional()
    @Inject(RECONCILE_LIVE_VIEW_SETTINGS_JOB_OPTIONS)
    options: ReconcileLiveViewSettingsJobOptions = {},
    @Optional()
    private readonly restartActivation?: LiveViewRestartActivationService,
    @Optional() private readonly outcomes?: LiveViewSettingsOutcomeRegistryService,
  ) {
    this.maxResultPolls = positiveInteger(
      options.maxResultPolls ?? DEFAULT_MAX_RESULT_POLLS,
      "live view settings result poll bound",
    );
    this.resultPollIntervalMs = positiveInteger(
      options.resultPollIntervalMs ?? DEFAULT_RESULT_POLL_INTERVAL_MS,
      "live view settings result poll interval",
    );
    this.sleep = options.sleep ?? sleep;
  }

  execute(jobId: string): Promise<ReconcileLiveViewSettingsJobResult> {
    return this.coordinator.run("settings", async (lease) => {
      const gateEpoch = this.gate.close();
      const job = await this.jobs.findById(jobId);
      if (job === null) throw new LiveViewPolicyApplyError();

      switch (job.status) {
        case "prepared":
          return this.resumePrepared(job, lease, gateEpoch);
        case "published":
          return this.resumePublished(job, lease, gateEpoch);
        case "committed":
        case "restart-required":
          return this.resumeCommitted(job, lease, gateEpoch);
        case "succeeded":
          return this.resumeSucceeded(job, gateEpoch);
        case "failed":
          return this.resumeFailed(job, gateEpoch);
      }
    });
  }

  private async resumePrepared(
    job: LiveViewSettingsJob,
    lease: LiveViewPolicyMutationLease,
    gateEpoch: number,
  ): Promise<ReconcileLiveViewSettingsJobResult> {
    try {
      await this.sessions.quiesce();
    } catch {
      const failed = await this.terminalizeFailure(
        job,
        "live-work-not-quiescent",
      );
      return { kind: "failed", failureCode: failed.failureCode! };
    }

    let policyState: PolicyState;
    try {
      policyState = await this.readPolicyState();
    } catch {
      const failed = await this.terminalizeFailure(
        job,
        "request-publish-failed",
      );
      return { kind: "failed", failureCode: failed.failureCode! };
    }

    if (policyState.rtspEnabled && job.candidateSettings.enabled && job.candidateSettings.allowedCameraCidrs.length === 0) {
      await this.terminalizeFailure(job, 'request-invalid');
      return { kind: 'failed', failureCode: 'request-invalid' };
    }

    const request = createLiveViewPolicyRequestV1({
      version: 1,
      kind: "settings-mutation",
      requestId: job.id,
      expectedGeneration: job.expectedGeneration,
      rtspEnabled: policyState.rtspEnabled,
      settings: job.candidateSettings,
    });

    try {
      await this.requests.publish(request);
    } catch {
      // Publication uses a durable link. A thrown cleanup step can be
      // indistinguishable from a successful publication, so retain the job.
      lease.markRestartPending();
      throw new LiveViewPolicyApplyError();
    }

    return this.retainPublishedOnUncertainty(lease, async () => {
      const published = await this.jobs.markPublished(job.id, this.clock.now());
      return this.runPublished(
        published,
        policyState,
        lease,
        gateEpoch,
      );
    });
  }

  private retainPublishedOnUncertainty<T>(
    lease: LiveViewPolicyMutationLease,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation().catch(() => {
      lease.markRestartPending();
      throw new LiveViewPolicyApplyError();
    });
  }

  private resumePublished(
    job: LiveViewSettingsJob,
    lease: LiveViewPolicyMutationLease,
    gateEpoch: number,
  ): Promise<ReconcileLiveViewSettingsJobResult> {
    return this.retainPublishedOnUncertainty(lease, async () => {
      const policyState = await this.readPolicyState();
      return this.runPublished(job, policyState, lease, gateEpoch);
    });
  }

  private async runPublished(
    job: LiveViewSettingsJob,
    policyState: PolicyState,
    lease: LiveViewPolicyMutationLease,
    gateEpoch: number,
  ): Promise<ReconcileLiveViewSettingsJobResult> {
    try {
      await this.controller.start();
    } catch {
      return this.handleUnitStartFailure(job, lease, gateEpoch);
    }

    const terminal = await this.pollResult(job.id);
    if (terminal === null) {
      const committed = await this.settings.readCommitted().catch(() => {
        throw new LiveViewPolicyApplyError();
      });
      if (isExactTarget(committed, job)) {
        const committedJob = await this.jobs.markCommitted(
          job.id,
          this.clock.now(),
        );
        lease.markRestartPending();
        return this.dispatchRestart(committedJob, lease, gateEpoch);
      }
      if (committed.generation !== job.expectedGeneration) {
        throw new LiveViewPolicyApplyError();
      }
      lease.markRestartPending();
      return { kind: "pending" };
    }

    const verified = verifyTerminalResult(terminal, job, policyState);
    if (verified.outcome === "failed") {
      const failureCode = verified.failureCode;
      if (failureCode === null) throw new LiveViewPolicyApplyError();
      const failed = await this.terminalizeFailure(job, failureCode);
      await this.acknowledgeAndCleanup(job.id);
      await this.restoreOldGateIfSafe(
        failed,
        policyState,
        gateEpoch,
        failureCode,
      );
      return { kind: "failed", failureCode };
    }

    const committed = await this.settings.readCommitted().catch(() => {
      throw new LiveViewPolicyApplyError();
    });
    if (!isExactTarget(committed, job)) throw new LiveViewPolicyApplyError();

    const committedJob = await this.jobs.markCommitted(
      job.id,
      this.clock.now(),
    );
    lease.markRestartPending();
    await this.acknowledgeAndCleanup(job.id);
    return this.dispatchRestart(committedJob, lease, gateEpoch);
  }

  private async handleUnitStartFailure(
    job: LiveViewSettingsJob,
    lease: LiveViewPolicyMutationLease,
    gateEpoch: number,
  ): Promise<ReconcileLiveViewSettingsJobResult> {
    const committed = await this.settings.readCommitted().catch(() => null);
    if (committed !== null && isExactTarget(committed, job)) {
      const committedJob = await this.jobs.markCommitted(
        job.id,
        this.clock.now(),
      );
      lease.markRestartPending();
      return this.dispatchRestart(committedJob, lease, gateEpoch);
    }

    lease.markRestartPending();
    return { kind: "pending" };
  }

  private async resumeCommitted(
    job: LiveViewSettingsJob,
    lease: LiveViewPolicyMutationLease,
    gateEpoch: number,
  ): Promise<ReconcileLiveViewSettingsJobResult> {
    let policyState: PolicyState;
    let committed: LiveViewSettingsDocument;
    try {
      [policyState, committed] = await Promise.all([
        this.readPolicyState(),
        this.settings.readCommitted(),
      ]);
    } catch {
      lease.markRestartPending();
      return { kind: "restart-required" };
    }

    if (!isExactTarget(committed, job)) {
      lease.markRestartPending();
      return { kind: "restart-required" };
    }

    if (this.settings.bootLoadedGeneration() === committed.generation) {
      const ready = await this.isReady(committed, policyState).catch(
        () => false,
      );
      if (!ready) {
        lease.markRestartPending();
        return { kind: "restart-required" };
      }

      let terminal: LiveViewPolicyResultV1 | null;
      try {
        terminal = await this.results.read(job.id);
        if (
          terminal !== null &&
          verifyTerminalResult(terminal, job, policyState).outcome !==
            "succeeded"
        ) {
          lease.markRestartPending();
          return { kind: "restart-required" };
        }
      } catch {
        lease.markRestartPending();
        return { kind: "restart-required" };
      }

      await this.jobs.terminalizeSuccess(job.id, this.clock.now());
      this.restartActivation?.cancelOnBoot(job.id);
      if (terminal !== null) await this.acknowledgeAndCleanup(job.id);
      if (committed.enabled) this.gate.openIfCurrent(gateEpoch);
      return { kind: "succeeded" };
    }

    lease.markRestartPending();
    if (job.status === "restart-required") return { kind: "restart-required" };
    return this.dispatchRestart(job, lease, gateEpoch);
  }

  private async resumeSucceeded(
    job: LiveViewSettingsJob,
    gateEpoch: number,
  ): Promise<ReconcileLiveViewSettingsJobResult> {
    let committed: LiveViewSettingsDocument;
    let policyState: PolicyState;
    try {
      [committed, policyState] = await Promise.all([
        this.settings.readCommitted(),
        this.readPolicyState(),
      ]);
    } catch {
      return { kind: "restart-required" };
    }
    if (
      !isExactTarget(committed, job) ||
      this.settings.bootLoadedGeneration() !== committed.generation ||
      !(await this.isReady(committed, policyState).catch(() => false))
    ) {
      return { kind: "restart-required" };
    }

    await this.acknowledgeMatchingTerminalResult(job, policyState);
    if (committed.enabled) this.gate.openIfCurrent(gateEpoch);
    return { kind: "succeeded" };
  }

  private async resumeFailed(
    job: LiveViewSettingsJob,
    gateEpoch: number,
  ): Promise<ReconcileLiveViewSettingsJobResult> {
    const policyState = await this.readPolicyState().catch(() => null);
    if (policyState !== null) {
      await this.acknowledgeMatchingTerminalResult(job, policyState);
      await this.restoreOldGateIfSafe(
        job,
        policyState,
        gateEpoch,
        job.failureCode!,
      );
    }
    return { kind: "failed", failureCode: job.failureCode! };
  }

  private async dispatchRestart(
    job: LiveViewSettingsJob,
    lease: LiveViewPolicyMutationLease,
    gateEpoch: number,
  ): Promise<ReconcileLiveViewSettingsJobResult> {
    await this.outcomes?.notifyPreRestart(job);
    const restartGateEpoch = this.restartActivation?.arm(job.id, job.expectedGeneration) ?? gateEpoch;
    try {
      await this.restarter.restart(() =>
        this.settings.simulateDevelopmentRestart(),
      );
      const current = await this.jobs.findById(job.id);
      if (current?.status === 'restart-required') return { kind: 'restart-required' };
      if (current && this.settings.bootLoadedGeneration() !== job.expectedGeneration) {
        return this.resumeCommitted(current, lease, restartGateEpoch);
      }
      return { kind: "resumed" };
    } catch {
      try {
        await this.jobs.markRestartRequired(
          job.id,
          "restart-dispatch-failed",
          this.clock.now(),
        );
      } catch {
        const current = await this.jobs.findById(job.id);
        if (current?.status !== "restart-required") {
          return { kind: "restart-required" };
        }
      }
      return { kind: "restart-required" };
    }
  }

  private async terminalizeFailure(
    job: LiveViewSettingsJob,
    failureCode: LiveViewSettingsJobFailureCode,
  ): Promise<LiveViewSettingsJob> {
    try {
      return await this.jobs.terminalizeFailure(
        job.id,
        failureCode,
        this.clock.now(),
      );
    } catch {
      const current = await this.jobs.findById(job.id);
      if (current?.status === "failed" && current.failureCode === failureCode) {
        return current;
      }
      throw new LiveViewPolicyApplyError();
    }
  }

  private async acknowledgeMatchingTerminalResult(
    job: LiveViewSettingsJob,
    policyState: PolicyState,
  ): Promise<void> {
    const terminal = await this.results.read(job.id).catch(() => null);
    if (terminal === null) return;

    const verified = verifyTerminalResult(terminal, job, policyState);
    if (
      (job.status === "succeeded" && verified.outcome !== "succeeded") ||
      (job.status === "failed" &&
        (verified.outcome !== "failed" ||
          verified.failureCode !== job.failureCode))
    ) {
      throw new LiveViewPolicyApplyError();
    }
    await this.acknowledgeAndCleanup(job.id);
  }

  private async acknowledgeAndCleanup(requestId: string): Promise<void> {
    try {
      await this.acknowledgements.publish(requestId);
    } catch {
      return;
    }
    await this.controller.start().catch(() => undefined);
  }

  private async readPolicyState(): Promise<PolicyState> {
    const features = await this.features.listAll();
    const rtsp = features.find(({ name }) => name === "rtsp");
    return { rtspEnabled: Boolean(rtsp?.installed && rtsp.enabled) };
  }

  private async isReady(
    committed: LiveViewSettingsDocument,
    policyState: PolicyState,
  ): Promise<boolean> {
    if (!committed.enabled) return true;
    if (!(await this.capability.isAvailable("motion-mjpeg"))) return false;
    return (
      !policyState.rtspEnabled || (await this.capability.isAvailable("rtsp"))
    );
  }

  private async restoreOldGateIfSafe(
    job: LiveViewSettingsJob,
    policyState: PolicyState,
    gateEpoch: number,
    failureCode: LiveViewSettingsJobFailureCode,
  ): Promise<void> {
    if (!canRestoreOldPolicy(failureCode)) return;
    const committed = await this.settings.readCommitted().catch(() => null);
    if (committed?.generation !== job.expectedGeneration) return;
    if (!(await this.isReady(committed, policyState).catch(() => false)))
      return;
    if (committed.enabled) this.gate.openIfCurrent(gateEpoch);
  }

  private async pollResult(
    requestId: string,
  ): Promise<LiveViewPolicyResultV1 | null> {
    for (let attempt = 0; attempt < this.maxResultPolls; attempt += 1) {
      const result = await this.results.read(requestId).catch(() => {
        throw new LiveViewPolicyApplyError();
      });
      if (result !== null) return result;
      if (attempt + 1 < this.maxResultPolls) {
        await this.sleep(this.resultPollIntervalMs);
      }
    }
    return null;
  }
}

function verifyTerminalResult(
  value: LiveViewPolicyResultV1,
  job: LiveViewSettingsJob,
  policyState: PolicyState,
): LiveViewPolicyResultV1 {
  const terminal = createLiveViewPolicyResultV1(value);
  if (terminal.kind !== "settings-mutation" || terminal.requestId !== job.id) {
    throw new LiveViewPolicyApplyError();
  }
  if (
    terminal.outcome === "succeeded" &&
    (terminal.resultingGeneration !== job.expectedGeneration + 1 ||
      terminal.resultingRtspEnabled !== policyState.rtspEnabled)
  ) {
    throw new LiveViewPolicyApplyError();
  }
  return terminal;
}

function isExactTarget(
  committed: LiveViewSettingsDocument,
  job: LiveViewSettingsJob,
): boolean {
  return (
    committed.version === 1 &&
    committed.generation === job.expectedGeneration + 1 &&
    committed.enabled === job.candidateSettings.enabled &&
    equalStrings(
      committed.allowedCameraCidrs,
      job.candidateSettings.allowedCameraCidrs,
    )
  );
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function canRestoreOldPolicy(
  failureCode: LiveViewSettingsJobFailureCode,
): boolean {
  return (
    failureCode === "unit-start-failed" ||
    failureCode === "request-invalid" ||
    failureCode === "stale-generation" ||
    failureCode === "interrupted"
  );
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
