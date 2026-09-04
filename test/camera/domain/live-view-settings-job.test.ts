import { describe, expect, it } from "vitest";

import { LiveViewSettingsBusyError } from "../../../src/camera/domain/errors/live-view-settings-busy.error";
import { LiveViewSettingsStateError } from "../../../src/camera/domain/errors/live-view-settings-state.error";
import {
  canTransitionLiveViewSettingsJob,
  createLiveViewSettingsJob,
  transitionLiveViewSettingsJob,
} from "../../../src/camera/domain/live-view-settings-job";

const prepared = createLiveViewSettingsJob({
  id: "AbCdEfGhIjKlMnOp",
  status: "prepared",
  expectedGeneration: 4,
  candidateSettings: { enabled: true, allowedCameraCidrs: ["192.168.1.0/24"] },
  failureCode: null,
});

describe("LiveViewSettingsJob transitions", () => {
  it("permits the durable active progression", () => {
    expect(canTransitionLiveViewSettingsJob("prepared", "published")).toBe(
      true,
    );
    expect(canTransitionLiveViewSettingsJob("published", "committed")).toBe(
      true,
    );
    expect(
      canTransitionLiveViewSettingsJob("committed", "restart-required"),
    ).toBe(true);
    expect(
      canTransitionLiveViewSettingsJob("restart-required", "succeeded"),
    ).toBe(true);
  });

  it("rejects illegal jumps and terminal rewrites", () => {
    expect(canTransitionLiveViewSettingsJob("prepared", "succeeded")).toBe(
      false,
    );
    expect(canTransitionLiveViewSettingsJob("failed", "published")).toBe(false);
    expect(() => transitionLiveViewSettingsJob(prepared, "succeeded")).toThrow(
      LiveViewSettingsStateError,
    );
  });

  it("requires a closed failure code union for terminal failures", () => {
    expect(() =>
      createLiveViewSettingsJob({
        ...prepared,
        status: "failed",
        failureCode: "unknown-failure",
      }),
    ).toThrow(LiveViewSettingsStateError);
  });

  it("turns a valid terminal failure into an inactive job", () => {
    expect(
      transitionLiveViewSettingsJob(
        prepared,
        "failed",
        "request-publish-failed",
      ),
    ).toMatchObject({
      status: "failed",
      failureCode: "request-publish-failed",
      activeSlot: null,
    });
  });

  it("requires a bounded restart code while restart remains active", () => {
    expect(
      createLiveViewSettingsJob({
        id: prepared.id,
        status: "restart-required",
        expectedGeneration: prepared.expectedGeneration,
        candidateSettings: prepared.candidateSettings,
        failureCode: "restart-activation-timeout",
      }),
    ).toMatchObject({
      status: "restart-required",
      failureCode: "restart-activation-timeout",
      activeSlot: 1,
    });
    expect(() =>
      createLiveViewSettingsJob({
        id: prepared.id,
        status: "restart-required",
        expectedGeneration: prepared.expectedGeneration,
        candidateSettings: prepared.candidateSettings,
        failureCode: "request-publish-failed",
      }),
    ).toThrow(LiveViewSettingsStateError);
  });

  it("rejects attempts to create a second active job from an active one", () => {
    expect(() => transitionLiveViewSettingsJob(prepared, "prepared")).toThrow(
      LiveViewSettingsBusyError,
    );
  });
});
