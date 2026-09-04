import { describe, expect, it, vi } from "vitest";
import { LiveViewPolicyCoordinatorService } from "../../../src/camera/application/live-view-policy-coordinator.service";
import { LiveViewSettingsBusyError } from "../../../src/camera/domain/errors/live-view-settings-busy.error";

describe("LiveViewPolicyCoordinatorService", () => {
  it("rejects a concurrent mutation immediately instead of queueing it", async () => {
    const coordinator = new LiveViewPolicyCoordinatorService();
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondOperation = vi.fn(async () => undefined);

    const first = coordinator.run("settings", async () => firstBlocked);

    await expect(
      coordinator.run("rtsp-state", secondOperation),
    ).rejects.toBeInstanceOf(LiveViewSettingsBusyError);
    expect(secondOperation).not.toHaveBeenCalled();

    releaseFirst?.();
    await expect(first).resolves.toBeUndefined();
  });

  it("latches restart-pending and rejects every later mutation", async () => {
    const coordinator = new LiveViewPolicyCoordinatorService();

    await coordinator.run("rtsp-state", async (lease) => {
      lease.markRestartPending();
    });

    expect(coordinator.isRestartPending()).toBe(true);
    await expect(
      coordinator.run("settings", async () => undefined),
    ).rejects.toBeInstanceOf(LiveViewSettingsBusyError);
  });

  it("releases an ordinary lease after either success or failure", async () => {
    const coordinator = new LiveViewPolicyCoordinatorService();
    const failure = new Error("mutation failed");

    await expect(
      coordinator.run("settings", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(
      coordinator.run("rtsp-state", async () => "recovered"),
    ).resolves.toBe("recovered");
    expect(coordinator.isRestartPending()).toBe(false);
  });
});
