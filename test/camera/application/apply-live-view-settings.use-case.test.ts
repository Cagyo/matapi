import { describe, expect, it, vi } from "vitest";

import { ApplyLiveViewSettingsUseCase } from "../../../src/camera/application/apply-live-view-settings.use-case";
import {
  LiveViewPolicyCoordinatorService,
  type LiveViewPolicyMutationKind,
  type LiveViewPolicyMutationLease,
} from "../../../src/camera/application/live-view-policy-coordinator.service";
import {
  ReconcileLiveViewSettingsJobUseCase,
  type ReconcileLiveViewSettingsJobOptions,
} from "../../../src/camera/application/reconcile-live-view-settings-job.use-case";
import { LiveViewStartGate } from "../../../src/camera/application/live-view-start-gate.service";
import { LiveViewPolicyApplyError } from "../../../src/camera/domain/errors/live-view-policy-apply.error";
import type {
  LiveViewPolicyFailureCode,
  LiveViewPolicyRequestV1,
  LiveViewPolicyResultV1,
} from "../../../src/camera/domain/live-view-policy";
import type { LiveViewSettingsJob } from "../../../src/camera/domain/live-view-settings-job";
import type { LiveViewPolicyAcknowledgementPort } from "../../../src/camera/domain/ports/live-view-policy-acknowledgement.port";
import type { LiveViewPolicyControllerPort } from "../../../src/camera/domain/ports/live-view-policy-controller.port";
import type { LiveViewPolicyRequestPort } from "../../../src/camera/domain/ports/live-view-policy-request.port";
import type { LiveViewPolicyResultPort } from "../../../src/camera/domain/ports/live-view-policy-result.port";
import type { LiveViewSettingsStorePort } from "../../../src/camera/domain/ports/live-view-settings-store.port";
import { InMemoryLiveViewPolicyAdapter } from "../../../src/camera/infrastructure/in-memory-live-view-policy.adapter";
import { InMemoryLiveViewSettingsJobRepository } from "../../../src/camera/infrastructure/in-memory-live-view-settings-job.repository";
import { InMemoryLiveViewSettingsAdapter } from "../../../src/camera/infrastructure/in-memory-live-view-settings.adapter";
import type { LiveStreamCapabilityPort } from "../../../src/camera/domain/ports/live-stream-capability.port";
import type { CameraClockPort } from "../../../src/camera/domain/ports/camera-clock.port";
import type { FeatureQueryPort } from "../../../src/features/domain/ports/feature-query.port";
import type { ProcessRestarterPort } from "../../../src/system/domain/ports/process-restarter.port";

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
const COMMITTED = {
  version: 1 as const,
  generation: 5,
  ...CANDIDATE,
};

class OrderedCoordinator extends LiveViewPolicyCoordinatorService {
  constructor(private readonly order: string[]) {
    super();
  }

  override run<T>(
    kind: LiveViewPolicyMutationKind,
    operation: (lease: LiveViewPolicyMutationLease) => Promise<T>,
  ): Promise<T> {
    this.order.push(`coordinator:${kind}`);
    return super.run(kind, (lease) =>
      operation({
        markRestartPending: () => {
          this.order.push("restart-pending");
          lease.markRestartPending();
        },
      }),
    );
  }
}

class OrderedGate extends LiveViewStartGate {
  constructor(private readonly order: string[]) {
    super();
  }

  override close(): number {
    this.order.push("global-gate:close");
    return super.close();
  }
}

interface SetupOverrides {
  readonly settings?: LiveViewSettingsStorePort;
  readonly request?: LiveViewPolicyRequestPort;
  readonly controller?: LiveViewPolicyControllerPort;
  readonly result?: LiveViewPolicyResultPort;
  readonly acknowledgement?: LiveViewPolicyAcknowledgementPort;
  readonly restarter?: ProcessRestarterPort;
  readonly capability?: LiveStreamCapabilityPort;
  readonly quiesce?: () => Promise<void>;
  readonly features?: FeatureQueryPort;
  readonly order?: string[];
}

function succeededResult(
  overrides: Partial<LiveViewPolicyResultV1> = {},
): LiveViewPolicyResultV1 {
  return {
    version: 1,
    kind: "settings-mutation",
    requestId: JOB_ID,
    outcome: "succeeded",
    resultingGeneration: 5,
    resultingRtspEnabled: true,
    failureCode: null,
    ...overrides,
  };
}

function failedResult(
  failureCode: LiveViewPolicyFailureCode,
): LiveViewPolicyResultV1 {
  return {
    version: 1,
    kind: "settings-mutation",
    requestId: JOB_ID,
    outcome: "failed",
    resultingGeneration: null,
    resultingRtspEnabled: null,
    failureCode,
  };
}

function setup(overrides: SetupOverrides = {}) {
  const order = overrides.order ?? [];
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
  const markPublished = jobs.markPublished.bind(jobs);
  vi.spyOn(jobs, "markPublished").mockImplementation(async (id, now) => {
    const job = await markPublished(id, now);
    order.push("job:published");
    return job;
  });
  const markCommitted = jobs.markCommitted.bind(jobs);
  vi.spyOn(jobs, "markCommitted").mockImplementation(async (id, now) => {
    const job = await markCommitted(id, now);
    order.push("job:committed");
    return job;
  });

  const settings: LiveViewSettingsStorePort = overrides.settings ?? {
    readCommitted: vi.fn(async () => {
      order.push("settings:read-N+1");
      return COMMITTED;
    }),
    bootLoadedGeneration: vi.fn(() => 4),
    simulateDevelopmentRestart: vi.fn(async () => undefined),
  };
  const request: LiveViewPolicyRequestPort = overrides.request ?? {
    publish: vi.fn(async () => {
      order.push("request:publish");
      return "published";
    }),
  };
  let controllerCalls = 0;
  const controller: LiveViewPolicyControllerPort = overrides.controller ?? {
    start: vi.fn(async () => {
      controllerCalls += 1;
      if (controllerCalls === 1) order.push("unit:start");
    }),
  };
  const result: LiveViewPolicyResultPort = overrides.result ?? {
    read: vi.fn(async () => {
      order.push("result:success");
      return succeededResult();
    }),
  };
  const acknowledgement: LiveViewPolicyAcknowledgementPort =
    overrides.acknowledgement ?? {
      publish: vi.fn(async () => "published"),
    };
  const restarter: ProcessRestarterPort = overrides.restarter ?? {
    restart: vi.fn(async () => {
      order.push("restart:dispatch");
    }),
  };
  const capability: LiveStreamCapabilityPort = overrides.capability ?? {
    isAvailable: vi.fn(async () => true),
  };
  const features: FeatureQueryPort = overrides.features ?? {
    listAll: vi.fn(async () => [
      {
        name: "rtsp",
        installed: true,
        enabled: true,
        config: null,
        attentionReason: null,
      },
    ]),
  };
  const gate = new OrderedGate(order);
  gate.openIfCurrent(0);
  const coordinator = new OrderedCoordinator(order);
  const clock: CameraClockPort = { now: () => new Date(NOW) };
  const options: ReconcileLiveViewSettingsJobOptions = {
    maxResultPolls: 1,
    resultPollIntervalMs: 1,
    sleep: async () => undefined,
  };
  const reconcile = new ReconcileLiveViewSettingsJobUseCase(
    jobs,
    settings,
    features,
    gate,
    {
      quiesce:
        overrides.quiesce ?? (async () => order.push("sessions:quiesce")),
    },
    coordinator,
    request,
    controller,
    result,
    acknowledgement,
    restarter,
    capability,
    clock,
    options,
  );
  return {
    acknowledgement,
    apply: new ApplyLiveViewSettingsUseCase(reconcile),
    capability,
    controller,
    coordinator,
    gate,
    jobs,
    order,
    request,
    restarter,
    result,
    settings,
  };
}

async function jobOf(
  jobs: InMemoryLiveViewSettingsJobRepository,
): Promise<LiveViewSettingsJob> {
  const job = await jobs.findById(JOB_ID);
  if (!job) throw new Error("test job missing");
  return job;
}

describe("ApplyLiveViewSettingsUseCase", () => {
  it("orders the successful apply from settings lease through restart dispatch", async () => {
    const test = setup();

    await expect(test.apply.execute(JOB_ID)).resolves.toEqual({
      kind: "restart-dispatched",
    });

    expect(test.order).toEqual([
      "coordinator:settings",
      "global-gate:close",
      "sessions:quiesce",
      "request:publish",
      "job:published",
      "unit:start",
      "result:success",
      "settings:read-N+1",
      "job:committed",
      "restart-pending",
      "restart:dispatch",
    ]);
    expect(test.request.publish).toHaveBeenCalledWith({
      version: 1,
      kind: "settings-mutation",
      requestId: JOB_ID,
      expectedGeneration: 4,
      rtspEnabled: true,
      settings: CANDIDATE,
    });
    expect((await jobOf(test.jobs)).status).toBe("committed");
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("terminalizes a quiescence refusal before request publication and leaves the gate closed", async () => {
    const test = setup({
      quiesce: async () => {
        throw new Error("late lease did not drain");
      },
    });

    await expect(test.apply.execute(JOB_ID)).rejects.toBeInstanceOf(
      LiveViewPolicyApplyError,
    );

    expect(await jobOf(test.jobs)).toMatchObject({
      status: "failed",
      failureCode: "live-work-not-quiescent",
      activeSlot: null,
    });
    expect(test.request.publish).not.toHaveBeenCalled();
    expect(test.controller.start).not.toHaveBeenCalled();
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("accepts an idempotently published request and commits one generation", async () => {
    const settings = new InMemoryLiveViewSettingsAdapter(CURRENT);
    const policy = new InMemoryLiveViewPolicyAdapter(settings);
    await policy.publish({
      version: 1,
      kind: "settings-mutation",
      requestId: JOB_ID,
      expectedGeneration: 4,
      rtspEnabled: true,
      settings: CANDIDATE,
    });
    const test = setup({
      settings,
      request: policy,
      controller: policy,
      result: policy,
      acknowledgement: policy,
    });

    await expect(test.apply.execute(JOB_ID)).resolves.toEqual({
      kind: "restart-dispatched",
    });

    expect(policy.snapshot()).toMatchObject({
      settingsCommitCount: 1,
      resultWriteCount: 1,
    });
    expect(await settings.readCommitted()).toEqual(COMMITTED);
  });

  it("terminalizes a fixed-unit start refusal and only restores a proven-ready old gate", async () => {
    const start = vi.fn(async () => {
      throw new Error("systemd unavailable");
    });
    const test = setup({
      settings: new InMemoryLiveViewSettingsAdapter(CURRENT),
      controller: { start },
    });

    await expect(test.apply.execute(JOB_ID)).rejects.toBeInstanceOf(
      LiveViewPolicyApplyError,
    );

    expect(await jobOf(test.jobs)).toMatchObject({
      status: "failed",
      failureCode: "unit-start-failed",
    });
    expect(test.result.read).not.toHaveBeenCalled();
    expect(test.capability.isAvailable).toHaveBeenCalledWith("motion-mjpeg");
    expect(() => test.gate.assertCanStart()).not.toThrow();
  });

  it("does not reopen the gate when old dependency readiness cannot be proven", async () => {
    const test = setup({
      settings: new InMemoryLiveViewSettingsAdapter(CURRENT),
      controller: {
        start: vi.fn(async () => {
          throw new Error("systemd unavailable");
        }),
      },
      capability: { isAvailable: vi.fn(async () => false) },
    });

    await expect(test.apply.execute(JOB_ID)).rejects.toBeInstanceOf(
      LiveViewPolicyApplyError,
    );

    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("terminalizes a closed root failure before acknowledging and keeps uncertain policy fenced", async () => {
    const transitionOrder: string[] = [];
    const acknowledgement: LiveViewPolicyAcknowledgementPort = {
      publish: vi.fn(async () => {
        transitionOrder.push("ack");
        return "published";
      }),
    };
    const test = setup({
      result: { read: vi.fn(async () => failedResult("policy-apply-failed")) },
      acknowledgement,
    });
    const terminalize = test.jobs.terminalizeFailure.bind(test.jobs);
    vi.spyOn(test.jobs, "terminalizeFailure").mockImplementation(
      async (id, failureCode, now) => {
        const terminal = await terminalize(id, failureCode, now);
        transitionOrder.push("db:failed");
        return terminal;
      },
    );

    await expect(test.apply.execute(JOB_ID)).rejects.toBeInstanceOf(
      LiveViewPolicyApplyError,
    );

    expect(transitionOrder).toEqual(["db:failed", "ack"]);
    expect(await jobOf(test.jobs)).toMatchObject({
      status: "failed",
      failureCode: "policy-apply-failed",
    });
    expect(acknowledgement.publish).toHaveBeenCalledWith(JOB_ID);
    expect(test.controller.start).toHaveBeenCalledTimes(2);
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("leaves a mismatched terminal result active, unacknowledged, and fenced", async () => {
    const test = setup({
      result: {
        read: vi.fn(async () =>
          succeededResult({ requestId: "ZyXwVuTsRqPoNmLk" }),
        ),
      },
    });

    await expect(test.apply.execute(JOB_ID)).rejects.toBeInstanceOf(
      LiveViewPolicyApplyError,
    );

    expect(await jobOf(test.jobs)).toMatchObject({
      status: "published",
      activeSlot: 1,
    });
    expect(test.acknowledgement.publish).not.toHaveBeenCalled();
    expect(test.restarter.restart).not.toHaveBeenCalled();
    expect(test.coordinator.isRestartPending()).toBe(true);
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("requires the committed authority to be exactly generation N+1 and the candidate", async () => {
    const test = setup({
      settings: {
        readCommitted: vi.fn(async () => ({ ...COMMITTED, enabled: false })),
        bootLoadedGeneration: vi.fn(() => 4),
        simulateDevelopmentRestart: vi.fn(async () => undefined),
      },
    });

    await expect(test.apply.execute(JOB_ID)).rejects.toBeInstanceOf(
      LiveViewPolicyApplyError,
    );

    expect((await jobOf(test.jobs)).status).toBe("published");
    expect(test.acknowledgement.publish).not.toHaveBeenCalled();
    expect(test.restarter.restart).not.toHaveBeenCalled();
  });

  it("requires the root result to verify the exact generation and RTSP policy tuple", async () => {
    const test = setup({
      result: {
        read: vi.fn(async () =>
          succeededResult({ resultingRtspEnabled: false }),
        ),
      },
    });

    await expect(test.apply.execute(JOB_ID)).rejects.toBeInstanceOf(
      LiveViewPolicyApplyError,
    );

    expect((await jobOf(test.jobs)).status).toBe("published");
    expect(test.settings.readCommitted).not.toHaveBeenCalled();
    expect(test.acknowledgement.publish).not.toHaveBeenCalled();
  });

  it("latches an ambiguous request publication without terminalizing or starting the unit", async () => {
    const published: LiveViewPolicyRequestV1[] = [];
    const test = setup({
      request: {
        publish: vi.fn(async (request) => {
          published.push(request);
          throw new Error("temporary unlink failed after final link");
        }),
      },
    });

    await expect(test.apply.execute(JOB_ID)).rejects.toBeInstanceOf(
      LiveViewPolicyApplyError,
    );

    expect(published).toHaveLength(1);
    expect((await jobOf(test.jobs)).status).toBe("prepared");
    expect(test.coordinator.isRestartPending()).toBe(true);
    expect(test.controller.start).not.toHaveBeenCalled();
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("marks only the same committed job restart-required when dispatch fails", async () => {
    const test = setup({
      restarter: {
        restart: vi.fn(async () => {
          throw new Error("pm2 rejected restart");
        }),
      },
    });

    await expect(test.apply.execute(JOB_ID)).resolves.toEqual({
      kind: "restart-required",
    });

    expect(await jobOf(test.jobs)).toMatchObject({
      id: JOB_ID,
      status: "restart-required",
      activeSlot: 1,
      failureCode: "restart-dispatch-failed",
    });
    expect(test.coordinator.isRestartPending()).toBe(true);
    expect(() => test.gate.assertCanStart()).toThrow();
  });

  it("acknowledges only after commit and treats root cleanup retrigger as best effort", async () => {
    const transitionOrder: string[] = [];
    let starts = 0;
    const test = setup({
      controller: {
        start: vi.fn(async () => {
          starts += 1;
          transitionOrder.push(starts === 1 ? "unit:start" : "cleanup:start");
          if (starts === 2) throw new Error("cleanup trigger failed");
        }),
      },
      acknowledgement: {
        publish: vi.fn(async () => {
          transitionOrder.push("ack");
          return "published";
        }),
      },
      restarter: {
        restart: vi.fn(async () => transitionOrder.push("restart")),
      },
    });
    vi.mocked(test.jobs.markCommitted).mockRestore();
    const markCommitted = test.jobs.markCommitted.bind(test.jobs);
    vi.spyOn(test.jobs, "markCommitted").mockImplementation(async (id, now) => {
      const committed = await markCommitted(id, now);
      transitionOrder.push("db:committed");
      return committed;
    });

    await expect(test.apply.execute(JOB_ID)).resolves.toEqual({
      kind: "restart-dispatched",
    });

    expect(transitionOrder).toEqual([
      "unit:start",
      "db:committed",
      "ack",
      "cleanup:start",
      "restart",
    ]);
  });
});
