import { describe, expect, it, vi } from "vitest";

import { LiveViewPolicyCoordinatorService } from "../../../src/camera/application/live-view-policy-coordinator.service";
import {
  ReconcileLiveViewSettingsJobUseCase,
  type ReconcileLiveViewSettingsJobResult,
} from "../../../src/camera/application/reconcile-live-view-settings-job.use-case";
import { LiveViewStartGate } from "../../../src/camera/application/live-view-start-gate.service";
import { LiveViewPolicyApplyError } from "../../../src/camera/domain/errors/live-view-policy-apply.error";
import type {
  LiveViewPolicyRequestV1,
  LiveViewPolicyResultV1,
} from "../../../src/camera/domain/live-view-policy";
import type { LiveViewSettingsJobStatus } from "../../../src/camera/domain/live-view-settings-job";
import type { LiveStreamCapabilityPort } from "../../../src/camera/domain/ports/live-stream-capability.port";
import type { LiveViewPolicyAcknowledgementPort } from "../../../src/camera/domain/ports/live-view-policy-acknowledgement.port";
import type { LiveViewPolicyControllerPort } from "../../../src/camera/domain/ports/live-view-policy-controller.port";
import type { LiveViewPolicyRequestPort } from "../../../src/camera/domain/ports/live-view-policy-request.port";
import type { LiveViewPolicyResultPort } from "../../../src/camera/domain/ports/live-view-policy-result.port";
import type { LiveViewSettingsStorePort } from "../../../src/camera/domain/ports/live-view-settings-store.port";
import { InMemoryLiveViewPolicyAdapter } from "../../../src/camera/infrastructure/in-memory-live-view-policy.adapter";
import { InMemoryLiveViewSettingsJobRepository } from "../../../src/camera/infrastructure/in-memory-live-view-settings-job.repository";
import { InMemoryLiveViewSettingsAdapter } from "../../../src/camera/infrastructure/in-memory-live-view-settings.adapter";
import type { FeatureQueryPort } from "../../../src/features/domain/ports/feature-query.port";
import type { ProcessRestarterPort } from "../../../src/system/domain/ports/process-restarter.port";

const JOB_ID = "AbCdEfGhIjKlMnOp";
const RECEIPT_ID = "QrStUvWxYz012345";
const NOW = new Date("2030-01-02T03:04:05.000Z");
const CURRENT = {
  version: 1 as const,
  generation: 4,
  enabled: true,
  allowedCameraCidrs: ["192.168.1.0/24"],
};
const CANDIDATE = {
  enabled: true,
  allowedCameraCidrs: ["10.20.0.0/16"],
};
const TARGET = {
  version: 1 as const,
  generation: 5,
  ...CANDIDATE,
};
const REQUEST: LiveViewPolicyRequestV1 = {
  version: 1,
  kind: "settings-mutation",
  requestId: JOB_ID,
  expectedGeneration: 4,
  rtspEnabled: true,
  settings: CANDIDATE,
};

const FEATURES: FeatureQueryPort = {
  listAll: async () => [
    {
      name: "rtsp",
      installed: true,
      enabled: true,
      config: null,
      attentionReason: null,
    },
  ],
};
const READY: LiveStreamCapabilityPort = {
  isAvailable: async () => true,
};

function createPreparedJob(jobs: InMemoryLiveViewSettingsJobRepository): void {
  jobs.claimPrepared({
    id: JOB_ID,
    expectedGeneration: 4,
    candidateSettings: CANDIDATE,
    requestedByUserId: 11,
    requestedInChatId: 22,
    workflowReceiptId: RECEIPT_ID,
    now: NOW,
  });
}

function makeReconcile(input: {
  readonly jobs: InMemoryLiveViewSettingsJobRepository;
  readonly settings: LiveViewSettingsStorePort;
  readonly requests: LiveViewPolicyRequestPort;
  readonly controller: LiveViewPolicyControllerPort;
  readonly results: LiveViewPolicyResultPort;
  readonly acknowledgements: LiveViewPolicyAcknowledgementPort;
  readonly restarter?: ProcessRestarterPort;
  readonly capability?: LiveStreamCapabilityPort;
  readonly features?: FeatureQueryPort;
  readonly gate?: LiveViewStartGate;
  readonly quiesce?: () => Promise<void>;
}) {
  const gate = input.gate ?? new LiveViewStartGate();
  const quiesce = vi.fn(input.quiesce ?? (async () => undefined));
  const restarter = input.restarter ?? {
    restart: vi.fn(async () => undefined),
  };
  const reconcile = new ReconcileLiveViewSettingsJobUseCase(
    input.jobs,
    input.settings,
    input.features ?? FEATURES,
    gate,
    { quiesce },
    new LiveViewPolicyCoordinatorService(),
    input.requests,
    input.controller,
    input.results,
    input.acknowledgements,
    restarter,
    input.capability ?? READY,
    { now: () => new Date(NOW) },
    {
      maxResultPolls: 1,
      resultPollIntervalMs: 1,
      sleep: async () => undefined,
    },
  );
  return { gate, quiesce, reconcile, restarter };
}

async function arrangePhase(status: LiveViewSettingsJobStatus) {
  const jobs = new InMemoryLiveViewSettingsJobRepository();
  const settings = new InMemoryLiveViewSettingsAdapter(CURRENT);
  const policy = new InMemoryLiveViewPolicyAdapter(settings);
  createPreparedJob(jobs);

  if (status !== "prepared") {
    await policy.publish(REQUEST);
    await jobs.markPublished(JOB_ID, NOW);
    await policy.start();
  }
  if (
    status === "committed" ||
    status === "restart-required" ||
    status === "succeeded"
  ) {
    await jobs.markCommitted(JOB_ID, NOW);
  }
  if (status === "restart-required") {
    await jobs.markRestartRequired(JOB_ID, "restart-dispatch-failed", NOW);
  }
  if (status === "succeeded") {
    await settings.simulateDevelopmentRestart();
    await jobs.terminalizeSuccess(JOB_ID, NOW);
  }
  if (status === "failed") {
    if ((await jobs.findById(JOB_ID))?.status === "prepared") {
      await jobs.markPublished(JOB_ID, NOW);
    }
    await jobs.terminalizeFailure(JOB_ID, "policy-apply-failed", NOW);
  }
  return { jobs, policy, settings };
}

function observedRecoveryPath(input: {
  readonly initialStatus: LiveViewSettingsJobStatus;
  readonly outcome: ReconcileLiveViewSettingsJobResult;
  readonly publishCalls: number;
  readonly quiesceCalls: number;
  readonly controllerCalls: number;
}): string {
  if (input.quiesceCalls === 1 && input.publishCalls === 1) {
    return "resume-quiesce-and-publish";
  }
  if (input.initialStatus === "published" && input.controllerCalls >= 1) {
    return "retrigger-and-read-result";
  }
  if (
    input.initialStatus === "committed" &&
    input.outcome.kind === "succeeded"
  ) {
    return "verify-activation-only";
  }
  if (
    input.initialStatus === "restart-required" &&
    input.outcome.kind === "restart-required"
  ) {
    return "offer-restart-only";
  }
  return "unexpected";
}

describe("ReconcileLiveViewSettingsJobUseCase", () => {
  it.each([
    ["prepared", "resume-quiesce-and-publish"],
    ["published", "retrigger-and-read-result"],
    ["committed", "verify-activation-only"],
    ["restart-required", "offer-restart-only"],
  ] as const)("recovers %s as %s", async (status, expected) => {
    const arranged = await arrangePhase(status);
    if (status === "committed") {
      await arranged.settings.simulateDevelopmentRestart();
    }
    const publish = vi.fn((request: LiveViewPolicyRequestV1) =>
      arranged.policy.publish(request),
    );
    const start = vi.spyOn(arranged.policy, "start");
    const test = makeReconcile({
      jobs: arranged.jobs,
      settings: arranged.settings,
      requests: { publish },
      controller: arranged.policy,
      results: arranged.policy,
      acknowledgements: {
        publish: (requestId) =>
          arranged.policy.publishAcknowledgement(requestId),
      },
    });

    const outcome = await test.reconcile.execute(JOB_ID);

    expect(
      observedRecoveryPath({
        initialStatus: status,
        outcome,
        publishCalls: publish.mock.calls.length,
        quiesceCalls: test.quiesce.mock.calls.length,
        controllerCalls: start.mock.calls.length,
      }),
    ).toBe(expected);
    if (status === "committed" || status === "restart-required") {
      expect(publish).not.toHaveBeenCalled();
      expect(test.quiesce).not.toHaveBeenCalled();
    }
  });

  it("terminalizes a prepared job as interrupted after a bounded terminal unit produces no request, result, or generation", async () => {
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    createPreparedJob(jobs);
    const settings = new InMemoryLiveViewSettingsAdapter(CURRENT);
    const requests: LiveViewPolicyRequestPort = {
      publish: vi.fn(async () => "published"),
    };
    const results: LiveViewPolicyResultPort = {
      read: vi.fn(async () => null),
    };
    const test = makeReconcile({
      jobs,
      settings,
      requests,
      controller: { start: vi.fn(async () => undefined) },
      results,
      acknowledgements: { publish: vi.fn(async () => "published") },
    });

    await expect(test.reconcile.execute(JOB_ID)).resolves.toEqual({
      kind: "failed",
      failureCode: "interrupted",
    });

    expect(await jobs.findById(JOB_ID)).toMatchObject({
      status: "failed",
      failureCode: "interrupted",
      activeSlot: null,
    });
    expect(await settings.readCommitted()).toEqual(CURRENT);
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("keeps a published job active when a replayable claim has no result yet", async () => {
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    createPreparedJob(jobs);
    await jobs.markPublished(JOB_ID, NOW);
    const settings = new InMemoryLiveViewSettingsAdapter(CURRENT);
    const test = makeReconcile({
      jobs,
      settings,
      requests: { publish: vi.fn(async () => "published") },
      controller: { start: vi.fn(async () => undefined) },
      results: { read: vi.fn(async () => null) },
      acknowledgements: { publish: vi.fn(async () => "published") },
    });

    await expect(test.reconcile.execute(JOB_ID)).resolves.toEqual({
      kind: "resumed",
    });

    expect(await jobs.findById(JOB_ID)).toMatchObject({
      status: "published",
      activeSlot: 1,
    });
  });

  it("keeps a committed job retryable when activation does not match the durable candidate", async () => {
    const arranged = await arrangePhase("committed");
    arranged.settings.setCommitted({ ...TARGET, enabled: false });
    await arranged.settings.simulateDevelopmentRestart();
    const test = makeReconcile({
      jobs: arranged.jobs,
      settings: arranged.settings,
      requests: arranged.policy,
      controller: arranged.policy,
      results: arranged.policy,
      acknowledgements: arranged.policy,
    });

    await expect(test.reconcile.execute(JOB_ID)).resolves.toEqual({
      kind: "restart-required",
    });

    expect(await arranged.jobs.findById(JOB_ID)).toMatchObject({
      status: "committed",
      activeSlot: 1,
    });
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("keeps a committed job retryable when dependency readiness is unavailable", async () => {
    const arranged = await arrangePhase("committed");
    await arranged.settings.simulateDevelopmentRestart();
    const test = makeReconcile({
      jobs: arranged.jobs,
      settings: arranged.settings,
      requests: arranged.policy,
      controller: arranged.policy,
      results: arranged.policy,
      acknowledgements: arranged.policy,
      capability: { isAvailable: vi.fn(async () => false) },
    });

    await expect(test.reconcile.execute(JOB_ID)).resolves.toEqual({
      kind: "restart-required",
    });

    expect(await arranged.jobs.findById(JOB_ID)).toMatchObject({
      status: "committed",
      activeSlot: 1,
    });
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("does not terminalize a committed job when its durable result tuple is stale", async () => {
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    createPreparedJob(jobs);
    await jobs.markPublished(JOB_ID, NOW);
    await jobs.markCommitted(JOB_ID, NOW);
    const settings = new InMemoryLiveViewSettingsAdapter(TARGET);
    await settings.simulateDevelopmentRestart();
    const acknowledgement = {
      publish: vi.fn(async () => "published" as const),
    };
    const test = makeReconcile({
      jobs,
      settings,
      requests: { publish: vi.fn(async () => "already-published") },
      controller: { start: vi.fn(async () => undefined) },
      results: {
        read: vi.fn(async () => ({
          version: 1,
          kind: "settings-mutation",
          requestId: JOB_ID,
          outcome: "succeeded",
          resultingGeneration: 4,
          resultingRtspEnabled: true,
          failureCode: null,
        })),
      },
      acknowledgements: acknowledgement,
    });

    await expect(test.reconcile.execute(JOB_ID)).resolves.toEqual({
      kind: "restart-required",
    });

    expect(await jobs.findById(JOB_ID)).toMatchObject({
      status: "committed",
      activeSlot: 1,
    });
    expect(acknowledgement.publish).not.toHaveBeenCalled();
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("retries a durable acknowledgement only after observing the matching terminal job", async () => {
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    createPreparedJob(jobs);
    await jobs.markPublished(JOB_ID, NOW);
    await jobs.terminalizeFailure(JOB_ID, "policy-apply-failed", NOW);
    const result: LiveViewPolicyResultV1 = {
      version: 1,
      kind: "settings-mutation",
      requestId: JOB_ID,
      outcome: "failed",
      resultingGeneration: null,
      resultingRtspEnabled: null,
      failureCode: "policy-apply-failed",
    };
    const order: string[] = [];
    const test = makeReconcile({
      jobs,
      settings: new InMemoryLiveViewSettingsAdapter(CURRENT),
      requests: { publish: vi.fn(async () => "published") },
      controller: {
        start: vi.fn(async () => {
          order.push("cleanup");
        }),
      },
      results: { read: vi.fn(async () => result) },
      acknowledgements: {
        publish: vi.fn(async () => {
          order.push("ack");
          return "already-published";
        }),
      },
    });

    await expect(test.reconcile.execute(JOB_ID)).resolves.toEqual({
      kind: "failed",
      failureCode: "policy-apply-failed",
    });

    expect(order).toEqual(["ack", "cleanup"]);
  });

  it("rejects a successful result whose tuple is stale without acknowledging it", async () => {
    const jobs = new InMemoryLiveViewSettingsJobRepository();
    createPreparedJob(jobs);
    await jobs.markPublished(JOB_ID, NOW);
    const acknowledgement = {
      publish: vi.fn(async () => "published" as const),
    };
    const stale: LiveViewPolicyResultV1 = {
      version: 1,
      kind: "settings-mutation",
      requestId: JOB_ID,
      outcome: "succeeded",
      resultingGeneration: 4,
      resultingRtspEnabled: true,
      failureCode: null,
    };
    const test = makeReconcile({
      jobs,
      settings: new InMemoryLiveViewSettingsAdapter(CURRENT),
      requests: { publish: vi.fn(async () => "published") },
      controller: { start: vi.fn(async () => undefined) },
      results: { read: vi.fn(async () => stale) },
      acknowledgements: acknowledgement,
    });

    await expect(test.reconcile.execute(JOB_ID)).rejects.toBeInstanceOf(
      LiveViewPolicyApplyError,
    );

    expect((await jobs.findById(JOB_ID))?.status).toBe("published");
    expect(acknowledgement.publish).not.toHaveBeenCalled();
  });
});

type CrashPoint =
  | "after-job-creation"
  | "after-request-link"
  | "after-job-published-cas"
  | "after-policy-rename"
  | "after-settings-rename"
  | "after-result-rename"
  | "after-job-committed-cas"
  | "after-result-acknowledgement";

async function arrangeCrash(point: CrashPoint) {
  const jobs = new InMemoryLiveViewSettingsJobRepository();
  const settings = new InMemoryLiveViewSettingsAdapter(CURRENT);
  const policy = new InMemoryLiveViewPolicyAdapter(settings);
  createPreparedJob(jobs);

  if (point === "after-job-creation") return { jobs, policy, settings };
  await policy.publish(REQUEST);
  if (point === "after-request-link") return { jobs, policy, settings };
  await jobs.markPublished(JOB_ID, NOW);
  if (point === "after-job-published-cas") return { jobs, policy, settings };

  if (point === "after-policy-rename") policy.pauseAfter("policy-rename");
  if (point === "after-settings-rename") policy.pauseAfter("settings-rename");
  if (point === "after-result-rename") policy.pauseAfter("result-rename");
  await policy.start();
  if (
    point === "after-policy-rename" ||
    point === "after-settings-rename" ||
    point === "after-result-rename"
  ) {
    return { jobs, policy, settings };
  }

  await jobs.markCommitted(JOB_ID, NOW);
  if (point === "after-job-committed-cas") return { jobs, policy, settings };
  await policy.publishAcknowledgement(JOB_ID);
  return { jobs, policy, settings };
}

describe("settings mutation crash recovery", () => {
  it.each([
    "after-job-creation",
    "after-request-link",
    "after-job-published-cas",
    "after-policy-rename",
    "after-settings-rename",
    "after-result-rename",
    "after-job-committed-cas",
    "after-result-acknowledgement",
  ] as const)("%s increments and terminalizes exactly once", async (point) => {
    const arranged = await arrangeCrash(point);
    const terminalize = vi.spyOn(arranged.jobs, "terminalizeSuccess");

    const first = makeReconcile({
      jobs: arranged.jobs,
      settings: arranged.settings,
      requests: arranged.policy,
      controller: arranged.policy,
      results: arranged.policy,
      acknowledgements: arranged.policy,
    });
    const firstOutcome = await first.reconcile.execute(JOB_ID);
    expect(["resumed", "restart-required", "succeeded"]).toContain(
      firstOutcome.kind,
    );

    if ((await arranged.jobs.findById(JOB_ID))?.status !== "succeeded") {
      await arranged.settings.simulateDevelopmentRestart();
      const boot = makeReconcile({
        jobs: arranged.jobs,
        settings: arranged.settings,
        requests: arranged.policy,
        controller: arranged.policy,
        results: arranged.policy,
        acknowledgements: arranged.policy,
      });
      await expect(boot.reconcile.execute(JOB_ID)).resolves.toEqual({
        kind: "succeeded",
      });
    }

    expect(await arranged.settings.readCommitted()).toEqual(TARGET);
    expect(await arranged.jobs.findById(JOB_ID)).toMatchObject({
      status: "succeeded",
      activeSlot: null,
      failureCode: null,
    });
    expect(arranged.policy.snapshot()).toMatchObject({
      settingsCommitCount: 1,
      resultWriteCount: 1,
    });
    expect(terminalize).toHaveBeenCalledTimes(1);
  });
});
