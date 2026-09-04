import { describe, expect, it, vi } from "vitest";

import { LiveViewPolicyCoordinatorService } from "../../../src/camera/application/live-view-policy-coordinator.service";
import { LiveViewStartGate } from "../../../src/camera/application/live-view-start-gate.service";
import { LiveViewSettingsRecoveryService } from "../../../src/camera/application/live-view-settings-recovery.service";
import { ReconcileLiveViewSettingsJobUseCase } from "../../../src/camera/application/reconcile-live-view-settings-job.use-case";
import type {
  LiveViewPolicyRequestV1,
  LiveViewPolicyResultV1,
} from "../../../src/camera/domain/live-view-policy";
import type { LiveViewPolicyAcknowledgementPort } from "../../../src/camera/domain/ports/live-view-policy-acknowledgement.port";
import type { LiveViewPolicyControllerPort } from "../../../src/camera/domain/ports/live-view-policy-controller.port";
import type { LiveViewPolicyRequestPort } from "../../../src/camera/domain/ports/live-view-policy-request.port";
import type { LiveViewPolicyResultPort } from "../../../src/camera/domain/ports/live-view-policy-result.port";
import { InMemoryLiveViewPolicyAdapter } from "../../../src/camera/infrastructure/in-memory-live-view-policy.adapter";
import { InMemoryLiveViewSettingsJobRepository } from "../../../src/camera/infrastructure/in-memory-live-view-settings-job.repository";
import { InMemoryLiveViewSettingsAdapter } from "../../../src/camera/infrastructure/in-memory-live-view-settings.adapter";

const JOB_ID = "AbCdEfGhIjKlMnOp";
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
const REQUEST: LiveViewPolicyRequestV1 = {
  version: 1,
  kind: "settings-mutation",
  requestId: JOB_ID,
  expectedGeneration: 4,
  rtspEnabled: true,
  settings: CANDIDATE,
};

function preparedJobs(): InMemoryLiveViewSettingsJobRepository {
  const jobs = new InMemoryLiveViewSettingsJobRepository();
  jobs.claimPrepared({
    id: JOB_ID,
    expectedGeneration: 4,
    candidateSettings: CANDIDATE,
    requestedByUserId: 11,
    requestedInChatId: 22,
    workflowReceiptId: "QrStUvWxYz012345",
    now: NOW,
  });
  return jobs;
}

function reconciler(execute: ReturnType<typeof vi.fn>) {
  return { execute } as unknown as ReconcileLiveViewSettingsJobUseCase;
}

function realRecovery(input: {
  readonly jobs: InMemoryLiveViewSettingsJobRepository;
  readonly settings: InMemoryLiveViewSettingsAdapter;
  readonly requests: LiveViewPolicyRequestPort;
  readonly controller: LiveViewPolicyControllerPort;
  readonly results: LiveViewPolicyResultPort;
  readonly acknowledgements: LiveViewPolicyAcknowledgementPort;
}) {
  const gate = new LiveViewStartGate();
  const reconcile = new ReconcileLiveViewSettingsJobUseCase(
    input.jobs,
    input.settings,
    {
      listAll: async () => [
        {
          name: "rtsp",
          installed: true,
          enabled: true,
          config: null,
          attentionReason: null,
        },
      ],
    },
    gate,
    { quiesce: async () => undefined },
    new LiveViewPolicyCoordinatorService(),
    input.requests,
    input.controller,
    input.results,
    input.acknowledgements,
    { restart: async () => undefined },
    { isAvailable: async () => true },
    { now: () => new Date(NOW) },
    {
      maxResultPolls: 1,
      resultPollIntervalMs: 1,
      sleep: async () => undefined,
    },
  );
  return {
    gate,
    recovery: new LiveViewSettingsRecoveryService(input.jobs, reconcile),
  };
}

describe("LiveViewSettingsRecoveryService", () => {
  it("is a no-op when there is no active settings job", async () => {
    const execute = vi.fn();
    const recovery = new LiveViewSettingsRecoveryService(
      new InMemoryLiveViewSettingsJobRepository(),
      reconciler(execute),
    );

    await expect(recovery.run()).resolves.toBeNull();

    expect(execute).not.toHaveBeenCalled();
  });

  it("reconciles the single durable active job by its exact id", async () => {
    const execute = vi.fn(async () => ({ kind: "resumed" as const }));
    const recovery = new LiveViewSettingsRecoveryService(
      preparedJobs(),
      reconciler(execute),
    );

    await expect(recovery.run()).resolves.toEqual({ kind: "resumed" });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(JOB_ID);
  });

  it("contains bootstrap reconciliation failure so uncertain work remains durable for retry", async () => {
    const execute = vi.fn(async () => {
      throw new Error("policy result temporarily unreadable");
    });
    const jobs = preparedJobs();
    const recovery = new LiveViewSettingsRecoveryService(
      jobs,
      reconciler(execute),
    );

    await expect(recovery.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(await jobs.findActive()).toMatchObject({
      id: JOB_ID,
      status: "prepared",
      activeSlot: 1,
    });
  });

  it("recovers a crash after success terminalization but before result acknowledgement", async () => {
    const jobs = preparedJobs();
    const settings = new InMemoryLiveViewSettingsAdapter(CURRENT);
    const policy = new InMemoryLiveViewPolicyAdapter(settings);
    await policy.publish(REQUEST);
    await jobs.markPublished(JOB_ID, NOW);
    await policy.start();
    await jobs.markCommitted(JOB_ID, NOW);
    await settings.simulateDevelopmentRestart();
    await jobs.terminalizeSuccess(JOB_ID, NOW);
    expect(policy.snapshot().result).toMatchObject({
      requestId: JOB_ID,
      outcome: "succeeded",
    });
    const test = realRecovery({
      jobs,
      settings,
      requests: policy,
      controller: policy,
      results: policy,
      acknowledgements: policy,
    });

    await expect(test.recovery.run()).resolves.toEqual({ kind: "succeeded" });

    expect(policy.snapshot()).toMatchObject({
      request: null,
      result: null,
      acknowledgedRequestId: null,
      settingsCommitCount: 1,
      resultWriteCount: 1,
    });
    expect(() => test.gate.assertCanStart()).not.toThrow();
  });

  it("recovers a crash after failure terminalization but before result acknowledgement", async () => {
    const jobs = preparedJobs();
    await jobs.markPublished(JOB_ID, NOW);
    await jobs.terminalizeFailure(JOB_ID, "policy-apply-failed", NOW);
    const terminal: LiveViewPolicyResultV1 = {
      version: 1,
      kind: "settings-mutation",
      requestId: JOB_ID,
      outcome: "failed",
      resultingGeneration: null,
      resultingRtspEnabled: null,
      failureCode: "policy-apply-failed",
    };
    const order: string[] = [];
    const test = realRecovery({
      jobs,
      settings: new InMemoryLiveViewSettingsAdapter(CURRENT),
      requests: { publish: vi.fn(async () => "already-published") },
      controller: {
        start: vi.fn(async () => {
          order.push("cleanup");
        }),
      },
      results: { read: vi.fn(async () => terminal) },
      acknowledgements: {
        publish: vi.fn(async () => {
          order.push("ack");
          return "published";
        }),
      },
    });

    await expect(test.recovery.run()).resolves.toEqual({
      kind: "failed",
      failureCode: "policy-apply-failed",
    });

    expect(order).toEqual(["ack", "cleanup"]);
    expect(() => test.gate.assertCanStart()).toThrow();
  });
});
