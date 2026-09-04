import { describe, expect, it, vi } from "vitest";
import { ReconcileRtspPolicyUseCase } from "../../../src/camera/application/reconcile-rtsp-policy.use-case";
import { LiveViewPolicyApplyError } from "../../../src/camera/domain/errors/live-view-policy-apply.error";
import type {
  LiveViewPolicyFailureCode,
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
  const useCase = new ReconcileRtspPolicyUseCase(
    settings,
    requests,
    controller,
    results,
    acknowledgements,
    {
      requestId: () => requestId,
      maxResultPolls: 3,
      resultPollIntervalMs: 25,
      sleep,
    },
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
    ]);
    expect(test.sleep).toHaveBeenCalledWith(25);
    expect(test.acknowledgements.publish).toHaveBeenCalledWith(requestId);
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
    },
  );
});
