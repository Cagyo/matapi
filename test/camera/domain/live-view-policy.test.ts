import { describe, expect, it } from "vitest";

import { LiveViewPolicyApplyError } from "../../../src/camera/domain/errors/live-view-policy-apply.error";
import {
  createLiveViewPolicyRequestV1,
  createLiveViewPolicyResultV1,
  deriveLiveViewPolicy,
} from "../../../src/camera/domain/live-view-policy";
import { LiveViewSettingsStateError } from "../../../src/camera/domain/errors/live-view-settings-state.error";

const settings = {
  version: 1 as const,
  generation: 4,
  enabled: true,
  allowedCameraCidrs: ["192.168.1.0/24"],
};

describe("deriveLiveViewPolicy", () => {
  it("uses a deny-all network list while RTSP is disabled", () => {
    expect(deriveLiveViewPolicy(settings, false).allowedCidrs).toEqual([]);
  });

  it("binds an enabled RTSP policy to the exact settings generation", () => {
    expect(deriveLiveViewPolicy(settings, true)).toMatchObject({
      settingsGeneration: settings.generation,
      rtspEnabled: true,
      allowedCidrs: settings.allowedCameraCidrs,
    });
  });

  it("uses deny-all when Watch live is disabled", () => {
    expect(
      deriveLiveViewPolicy({ ...settings, enabled: false }, true).allowedCidrs,
    ).toEqual([]);
  });
});

describe("live-view policy wire contracts", () => {
  it("rejects request keys outside the strict settings-mutation schema", () => {
    expect(() =>
      createLiveViewPolicyRequestV1({
        version: 1,
        kind: "settings-mutation",
        requestId: "AbCdEfGhIjKlMnOp",
        expectedGeneration: 4,
        rtspEnabled: true,
        settings: { enabled: true, allowedCameraCidrs: ["192.168.1.0/24"] },
        extra: true,
      }),
    ).toThrow(LiveViewSettingsStateError);
  });

  it("rejects numeric request booleans and unsafe generations", () => {
    expect(() =>
      createLiveViewPolicyRequestV1({
        version: 1,
        kind: "rtsp-state-reconcile",
        requestId: "AbCdEfGhIjKlMnOp",
        expectedGeneration: Number.MAX_SAFE_INTEGER + 1,
        rtspEnabled: 1,
      }),
    ).toThrow(LiveViewSettingsStateError);
  });

  it("enforces the correlated successful result tuple", () => {
    expect(
      createLiveViewPolicyResultV1({
        version: 1,
        kind: "settings-mutation",
        requestId: "AbCdEfGhIjKlMnOp",
        outcome: "succeeded",
        resultingGeneration: 5,
        resultingRtspEnabled: true,
        failureCode: null,
      }),
    ).toMatchObject({ outcome: "succeeded", resultingGeneration: 5 });
  });

  it("rejects a failed result that carries a success tuple", () => {
    expect(() =>
      createLiveViewPolicyResultV1({
        version: 1,
        kind: "settings-mutation",
        requestId: "AbCdEfGhIjKlMnOp",
        outcome: "failed",
        resultingGeneration: 5,
        resultingRtspEnabled: true,
        failureCode: "policy-apply-failed",
      }),
    ).toThrow(LiveViewPolicyApplyError);
  });
});
