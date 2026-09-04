import { describe, expect, it, vi } from "vitest";
import { FeatureCameraRuntimeLifecycleService } from "../../../src/camera/application/feature-camera-runtime-lifecycle.service";
import { LiveViewPolicyCoordinatorService } from "../../../src/camera/application/live-view-policy-coordinator.service";
import { ReconcileRtspPolicyUseCase } from "../../../src/camera/application/reconcile-rtsp-policy.use-case";
import { LiveViewPolicyApplyError } from "../../../src/camera/domain/errors/live-view-policy-apply.error";
import { LiveViewSettingsBusyError } from "../../../src/camera/domain/errors/live-view-settings-busy.error";
import type {
  LiveViewPolicyFailureCode,
  LiveViewPolicyRequestV1,
  LiveViewPolicyResultV1,
} from "../../../src/camera/domain/live-view-policy";
import type { LiveViewPolicyAcknowledgementPort } from "../../../src/camera/domain/ports/live-view-policy-acknowledgement.port";
import type { LiveViewPolicyControllerPort } from "../../../src/camera/domain/ports/live-view-policy-controller.port";
import type { LiveViewPolicyRequestPort } from "../../../src/camera/domain/ports/live-view-policy-request.port";
import type { LiveViewPolicyResultPort } from "../../../src/camera/domain/ports/live-view-policy-result.port";
import type { LiveViewSettingsStorePort } from "../../../src/camera/domain/ports/live-view-settings-store.port";

const requestId = "AbCdEfGhIjKlMnOp";
const committed = {
  version: 1,
  generation: 4,
  enabled: true,
  allowedCameraCidrs: ["192.168.1.0/24"],
} as const;

function succeeded(
  overrides: Partial<LiveViewPolicyResultV1> = {},
): LiveViewPolicyResultV1 {
  return {
    version: 1,
    kind: "rtsp-state-reconcile",
    requestId,
    outcome: "succeeded",
    resultingGeneration: 4,
    resultingRtspEnabled: true,
    failureCode: null,
    ...overrides,
  };
}

function failed(
  failureCode: LiveViewPolicyFailureCode,
): LiveViewPolicyResultV1 {
  return {
    version: 1,
    kind: "rtsp-state-reconcile",
    requestId,
    outcome: "failed",
    resultingGeneration: null,
    resultingRtspEnabled: null,
    failureCode,
  };
}

function setup(
  resultSteps: readonly (LiveViewPolicyResultV1 | null)[] = [succeeded()],
  options: { readonly useDefaultPollConfiguration?: boolean } = {},
) {
  const order: string[] = [];
  let resultRead = 0;
  const settings: LiveViewSettingsStorePort = {
    readCommitted: vi.fn(async () => {
      order.push("settings:read");
      return committed;
    }),
    bootLoadedGeneration: vi.fn(() => committed.generation),
    simulateDevelopmentRestart: vi.fn(async () => undefined),
  };
  const requests: LiveViewPolicyRequestPort = {
    publish: vi.fn(async () => {
      order.push("request:publish");
      return "published";
    }),
  };
  const controller: LiveViewPolicyControllerPort = {
    start: vi.fn(async () => {
      order.push("controller:start");
    }),
  };
  const results: LiveViewPolicyResultPort = {
    read: vi.fn(async () => {
      order.push("result:read");
      const result =
        resultSteps[Math.min(resultRead, resultSteps.length - 1)] ?? null;
      resultRead += 1;
      return result;
    }),
  };
  const acknowledgements: LiveViewPolicyAcknowledgementPort = {
    publish: vi.fn(async () => {
      order.push("ack:publish");
      return "published";
    }),
  };
  const sleep = vi.fn(async () => {
    order.push("poll:yield");
  });
  const useCaseOptions = options.useDefaultPollConfiguration
    ? { requestId: () => requestId, sleep }
    : {
        requestId: () => requestId,
        maxResultPolls: 3,
        resultPollIntervalMs: 25,
        sleep,
      };
  const useCase = new ReconcileRtspPolicyUseCase(
    settings,
    requests,
    controller,
    results,
    acknowledgements,
    useCaseOptions,
  );
  return {
    order,
    settings,
    requests,
    controller,
    results,
    acknowledgements,
    sleep,
    useCase,
  };
}

describe("ReconcileRtspPolicyUseCase", () => {
  it("publishes the strict request, yields while polling, validates the tuple, and acknowledges", async () => {
    const test = setup([null, succeeded()]);

    await expect(
      test.useCase.execute({ rtspEnabled: true }),
    ).resolves.toBeUndefined();

    expect(test.requests.publish).toHaveBeenCalledWith({
      version: 1,
      kind: "rtsp-state-reconcile",
      requestId,
      expectedGeneration: 4,
      rtspEnabled: true,
    });
    expect(test.order).toEqual([
      "settings:read",
      "request:publish",
      "controller:start",
      "result:read",
      "poll:yield",
      "result:read",
      "ack:publish",
      "controller:start",
    ]);
    expect(test.sleep).toHaveBeenCalledWith(25);
    expect(test.acknowledgements.publish).toHaveBeenCalledWith(requestId);
    expect(test.controller.start).toHaveBeenCalledTimes(2);
  });

  it("stops after the configured result bound and leaves an absent result unacknowledged", async () => {
    const test = setup([null]);

    await expect(
      test.useCase.execute({ rtspEnabled: true }),
    ).rejects.toBeInstanceOf(LiveViewPolicyApplyError);

    expect(test.results.read).toHaveBeenCalledTimes(3);
    expect(test.sleep).toHaveBeenCalledTimes(2);
    expect(test.acknowledgements.publish).not.toHaveBeenCalled();
  });

  it("reserves five seconds of the fixed unit timeout for activation and scheduling", async () => {
    const test = setup([null], { useDefaultPollConfiguration: true });

    await expect(
      test.useCase.execute({ rtspEnabled: true }),
    ).rejects.toBeInstanceOf(LiveViewPolicyApplyError);

    expect(test.results.read).toHaveBeenCalledTimes(221);
    expect(test.sleep).toHaveBeenCalledTimes(220);
    expect(test.sleep).toHaveBeenCalledWith(250);
  });

  it("does not fail a valid reconciliation when the post-ack cleanup trigger fails", async () => {
    const test = setup();
    test.controller.start
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cleanup trigger failed"));

    await expect(
      test.useCase.execute({ rtspEnabled: true }),
    ).resolves.toBeUndefined();

    expect(test.acknowledgements.publish).toHaveBeenCalledWith(requestId);
    expect(test.controller.start).toHaveBeenCalledTimes(2);
  });

  it("latches a request that became visible before publication rejected", async () => {
    const test = setup([succeeded({ resultingRtspEnabled: false })]);
    const visibleRequests: LiveViewPolicyRequestV1[] = [];
    test.requests.publish.mockImplementation(async (request) => {
      visibleRequests.push(request);
      if (visibleRequests.length === 1) {
        throw new Error("temporary unlink failed after target link");
      }
      return "published";
    });
    const composed = composeRtspTransition(test);
    let applyError: unknown;
    let compensationError: unknown;

    await runRtspTransition(composed.camera, async () => {
      try {
        await composed.camera.rtsp.afterEnable();
      } catch (error) {
        applyError = error;
        try {
          await composed.camera.rtsp.beforeDisable();
        } catch (compensationFailure) {
          compensationError = compensationFailure;
        }
      }
    });

    expect(applyError).toBeInstanceOf(LiveViewPolicyApplyError);
    expect(compensationError).toBeInstanceOf(LiveViewSettingsBusyError);
    expect(composed.coordinator.isRestartPending()).toBe(true);
    expect(visibleRequests).toEqual([
      {
        version: 1,
        kind: "rtsp-state-reconcile",
        requestId,
        expectedGeneration: 4,
        rtspEnabled: true,
      },
    ]);
    expect(test.requests.publish).toHaveBeenCalledTimes(1);
    expect(test.acknowledgements.publish).not.toHaveBeenCalled();
    await expect(
      runRtspTransition(composed.camera, () =>
        composed.camera.rtsp.afterEnable(),
      ),
    ).rejects.toBeInstanceOf(LiveViewSettingsBusyError);
    expect(test.requests.publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    "controller failure",
    "result read failure",
    "invalid result",
    "timeout",
    "acknowledgement failure",
  ] as const)(
    "latches %s after publication and blocks compensation or another request",
    async (scenario) => {
      const test =
        scenario === "invalid result"
          ? setup([succeeded({ resultingGeneration: 5 })])
          : scenario === "acknowledgement failure"
            ? setup()
            : setup([null]);
      if (scenario === "controller failure") {
        test.controller.start.mockRejectedValueOnce(
          new Error("controller failed"),
        );
      }
      if (scenario === "result read failure") {
        test.results.read.mockRejectedValueOnce(
          new Error("result read failed"),
        );
      }
      if (scenario === "acknowledgement failure") {
        test.acknowledgements.publish.mockRejectedValueOnce(
          new Error("acknowledgement publish failed"),
        );
      }
      const composed = composeRtspTransition(test);

      await expect(
        runUncertainRtspTransition(composed.camera),
      ).rejects.toBeInstanceOf(LiveViewPolicyApplyError);

      expect(composed.coordinator.isRestartPending()).toBe(true);
      expect(test.requests.publish).toHaveBeenCalledTimes(1);
      if (scenario === "acknowledgement failure") {
        expect(test.acknowledgements.publish).toHaveBeenCalledOnce();
      } else {
        expect(test.acknowledgements.publish).not.toHaveBeenCalled();
      }
      await expect(
        runRtspTransition(composed.camera, () =>
          composed.camera.rtsp.afterEnable(),
        ),
      ).rejects.toBeInstanceOf(LiveViewSettingsBusyError);
      expect(test.requests.publish).toHaveBeenCalledTimes(1);
    },
  );

  it("allows a valid closed helper failure to run opposite compensation under the same lease", async () => {
    const test = setup([
      failed("policy-apply-failed"),
      succeeded({ resultingRtspEnabled: false }),
    ]);
    const composed = composeRtspTransition(test);

    await expect(
      runRtspTransition(composed.camera, async () => {
        try {
          await composed.camera.rtsp.afterEnable();
        } catch (error) {
          await composed.camera.rtsp.beforeDisable();
          throw error;
        }
      }),
    ).rejects.toBeInstanceOf(LiveViewPolicyApplyError);

    expect(composed.coordinator.isRestartPending()).toBe(false);
    expect(test.requests.publish).toHaveBeenCalledTimes(2);
    expect(test.requests.publish).toHaveBeenNthCalledWith(1, {
      version: 1,
      kind: "rtsp-state-reconcile",
      requestId,
      expectedGeneration: 4,
      rtspEnabled: true,
    });
    expect(test.requests.publish).toHaveBeenNthCalledWith(2, {
      version: 1,
      kind: "rtsp-state-reconcile",
      requestId,
      expectedGeneration: 4,
      rtspEnabled: false,
    });
    expect(test.acknowledgements.publish).toHaveBeenCalledTimes(2);
    expect(test.controller.start).toHaveBeenCalledTimes(4);
    expect(composed.gate.close).toHaveBeenCalledOnce();
    expect(composed.gate.open).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong kind", succeeded({ kind: "settings-mutation" })],
    ["wrong request", succeeded({ requestId: "PqRsTuVwXyZaBcDe" })],
    ["wrong generation", succeeded({ resultingGeneration: 5 })],
    ["wrong RTSP state", succeeded({ resultingRtspEnabled: false })],
    ["additional key", { ...succeeded(), unexpected: true }],
    [
      "unknown failure code",
      { ...failed("interrupted"), failureCode: "unbounded-error" },
    ],
  ] as const)(
    "rejects a terminal result with %s without acknowledging it",
    async (_name, result) => {
      const test = setup([result as LiveViewPolicyResultV1]);

      await expect(
        test.useCase.execute({ rtspEnabled: true }),
      ).rejects.toBeInstanceOf(LiveViewPolicyApplyError);
      expect(test.acknowledgements.publish).not.toHaveBeenCalled();
    },
  );

  it.each([
    "request-invalid",
    "stale-generation",
    "settings-state-unsafe",
    "policy-apply-failed",
    "service-unhealthy",
    "rtsp-assets-absent",
    "interrupted",
    "helper-version-mismatch",
  ] satisfies readonly LiveViewPolicyFailureCode[])(
    "acknowledges the closed %s failure and maps it to a policy apply error",
    async (failureCode) => {
      const test = setup([failed(failureCode)]);

      await expect(
        test.useCase.execute({ rtspEnabled: true }),
      ).rejects.toBeInstanceOf(LiveViewPolicyApplyError);
      expect(test.acknowledgements.publish).toHaveBeenCalledWith(requestId);
      expect(test.controller.start).toHaveBeenCalledTimes(2);
    },
  );
});

type ReconcileHarness = ReturnType<typeof setup>;

function composeRtspTransition(test: ReconcileHarness) {
  const coordinator = new LiveViewPolicyCoordinatorService();
  const gate = { close: vi.fn(), open: vi.fn().mockResolvedValue(undefined) };
  const camera = new FeatureCameraRuntimeLifecycleService(
    { stop: vi.fn(), start: vi.fn() } as never,
    { stop: vi.fn() } as never,
    gate as never,
    {
      stopCamera: vi.fn().mockResolvedValue(undefined),
      stopSourceKind: vi.fn().mockResolvedValue(undefined),
    },
    { findActive: vi.fn().mockResolvedValue(null) },
    coordinator,
    test.useCase,
  );
  return { coordinator, camera, gate };
}

async function runUncertainRtspTransition(
  camera: FeatureCameraRuntimeLifecycleService,
): Promise<void> {
  await runRtspTransition(camera, async () => {
    try {
      await camera.rtsp.afterEnable();
    } catch (error) {
      await expect(camera.rtsp.beforeDisable()).rejects.toBeInstanceOf(
        LiveViewSettingsBusyError,
      );
      throw error;
    }
  });
}

function runRtspTransition<T>(
  camera: FeatureCameraRuntimeLifecycleService,
  operation: () => Promise<T>,
): Promise<T> {
  if (!camera.rtsp.runTransition)
    throw new Error("RTSP transition wrapper is missing");
  return camera.rtsp.runTransition(operation);
}
