import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveViewRestartActivationService } from "../../../src/camera/application/live-view-restart-activation.service";
import { LiveViewStartGate } from "../../../src/camera/application/live-view-start-gate.service";
import type { CameraClockPort } from "../../../src/camera/domain/ports/camera-clock.port";
import type { LiveViewSettingsStorePort } from "../../../src/camera/domain/ports/live-view-settings-store.port";
import { InMemoryLiveViewSettingsJobRepository } from "../../../src/camera/infrastructure/in-memory-live-view-settings-job.repository";
import type { ProcessRestarterPort } from "../../../src/system/domain/ports/process-restarter.port";

const JOB_ID = "AbCdEfGhIjKlMnOp";
const NOW = new Date("2030-01-02T03:04:05.000Z");

async function committedJob() {
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
  await jobs.markPublished(JOB_ID, NOW);
  await jobs.markCommitted(JOB_ID, NOW);
  return jobs;
}

function setup(jobs: InMemoryLiveViewSettingsJobRepository) {
  const settings: LiveViewSettingsStorePort = {
    readCommitted: vi.fn(async () => ({
      version: 1,
      generation: 5,
      enabled: true,
      allowedCameraCidrs: ["10.20.0.0/16"],
    })),
    bootLoadedGeneration: vi.fn(() => 4),
    simulateDevelopmentRestart: vi.fn(async () => undefined),
  };
  const restart = vi.fn(async () => undefined);
  const restarter: ProcessRestarterPort = { restart };
  const gate = new LiveViewStartGate();
  const clock: CameraClockPort = { now: () => new Date(NOW) };
  const activation = new LiveViewRestartActivationService(
    jobs,
    settings,
    gate,
    restarter,
    clock,
  );
  return { activation, gate, restart, settings };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveViewRestartActivationService", () => {
  it("marks the same committed job restart-required after the old process remains for 15 seconds", async () => {
    vi.useFakeTimers();
    const jobs = await committedJob();
    const test = setup(jobs);

    test.activation.arm(JOB_ID, 4);
    await vi.advanceTimersByTimeAsync(14_999);
    expect((await jobs.findById(JOB_ID))?.status).toBe("committed");

    await vi.advanceTimersByTimeAsync(1);

    expect(await jobs.findById(JOB_ID)).toMatchObject({
      id: JOB_ID,
      status: "restart-required",
      activeSlot: 1,
      failureCode: "restart-activation-timeout",
    });
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("retries only the process restart without mutating the active job", async () => {
    const jobs = await committedJob();
    const before = await jobs.findById(JOB_ID);
    const test = setup(jobs);

    await test.activation.retry(JOB_ID);

    expect(test.restart).toHaveBeenCalledOnce();
    expect(await jobs.findById(JOB_ID)).toEqual(before);
    expect(test.settings.simulateDevelopmentRestart).not.toHaveBeenCalled();
  });

  it("cancels the old-process deadline during boot reconciliation", async () => {
    vi.useFakeTimers();
    const jobs = await committedJob();
    const test = setup(jobs);

    test.activation.arm(JOB_ID, 4);
    test.activation.cancelOnBoot(JOB_ID);
    await vi.advanceTimersByTimeAsync(15_000);

    expect((await jobs.findById(JOB_ID))?.status).toBe("committed");
    expect(() => test.gate.assertCanStart()).toThrow();
  });
});
