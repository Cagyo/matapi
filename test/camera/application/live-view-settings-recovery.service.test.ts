import { describe, expect, it, vi } from "vitest";

import { LiveViewSettingsRecoveryService } from "../../../src/camera/application/live-view-settings-recovery.service";
import type { ReconcileLiveViewSettingsJobUseCase } from "../../../src/camera/application/reconcile-live-view-settings-job.use-case";
import { InMemoryLiveViewSettingsJobRepository } from "../../../src/camera/infrastructure/in-memory-live-view-settings-job.repository";

const JOB_ID = "AbCdEfGhIjKlMnOp";
const NOW = new Date("2030-01-02T03:04:05.000Z");

function preparedJobs(): InMemoryLiveViewSettingsJobRepository {
  const jobs = new InMemoryLiveViewSettingsJobRepository();
  jobs.claimPrepared({
    id: JOB_ID,
    expectedGeneration: 4,
    candidateSettings: {
      enabled: true,
      allowedCameraCidrs: ["10.20.0.0/16"],
    },
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
});
