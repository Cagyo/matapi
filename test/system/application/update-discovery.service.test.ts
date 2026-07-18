import { describe, expect, it, vi } from "vitest";
import type { CheckForUpdatesUseCase } from "../../../src/system/application/check-for-updates.use-case";
import type { UpdateDiscoveryClockPort } from "../../../src/system/application/ports/update-discovery-clock.port";
import type { UpdateDiscoveryRandomPort } from "../../../src/system/application/ports/update-discovery-random.port";
import type { UpdateDiscoveryTimerPort } from "../../../src/system/application/ports/update-discovery-timer.port";
import { UpdateDiscoveryService } from "../../../src/system/application/update-discovery.service";
import type {
  OtaAdminNotificationPort,
  OtaAdminNotice,
} from "../../../src/system/domain/ports/ota-admin-notification.port";
import type {
  CheckedReleaseIdentity,
  UpdateCheck,
} from "../../../src/system/domain/ota-contracts";

const available: CheckedReleaseIdentity = {
  artifact: {
    version: "1.4.3",
    commit: "0123456789abcdef0123456789abcdef01234567",
    targetName: "linux-armv7-glibc",
    target: {
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcMinVersion: "2.28",
      nodeModulesAbi: "115",
    },
    url: "https://updates.example.test/release.tar.gz",
    format: "tar.gz",
    size: 1,
    expandedSize: 1,
    maxPreparedSize: 1,
    maxPreparedFiles: 1,
    fileCount: 1,
    sha256: "a".repeat(64),
  },
  metadata: {
    metadataVersion: 43,
    channel: "stable",
    payloadSha256: "b".repeat(64),
    publishedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-31T00:00:00.000Z",
  },
};

function harness(
  result: UpdateCheck = {
    kind: "failure",
    failure: { code: "signature-invalid" },
  },
) {
  const startUpdate = vi.fn();
  const check = {
    execute: vi.fn().mockResolvedValue(result),
    isAvailableNotificationDue: vi.fn().mockResolvedValue(true),
    acknowledgeAvailableNotification: vi.fn().mockResolvedValue(undefined),
    isFailureNotificationDue: vi.fn().mockResolvedValue(true),
    acknowledgeFailureNotification: vi.fn().mockResolvedValue(undefined),
    startUpdate,
  } as unknown as CheckForUpdatesUseCase;
  const deliveredNotices: OtaAdminNotice[] = [];
  const notifications: OtaAdminNotificationPort = {
    deliver: vi.fn(async (notice) => {
      deliveredNotices.push(notice);
      return { delivered: 1 };
    }),
  };
  const timeouts: { callback: () => void; delay: number }[] = [];
  const intervals: { callback: () => void; delay: number }[] = [];
  const timer: UpdateDiscoveryTimerPort = {
    setTimeout: vi.fn((callback, delay) => {
      timeouts.push({ callback, delay });
      return { kind: "timeout" };
    }),
    clearTimeout: vi.fn(),
    setInterval: vi.fn((callback, delay) => {
      intervals.push({ callback, delay });
      return { kind: "interval" };
    }),
    clearInterval: vi.fn(),
  };
  const clock: UpdateDiscoveryClockPort = {
    now: vi.fn(() => new Date("2030-01-15T12:00:00.000Z")),
  };
  const random: UpdateDiscoveryRandomPort = { next: vi.fn(() => 1) };
  const service = new UpdateDiscoveryService(
    check,
    notifications,
    clock,
    timer,
    random,
    {
      pollIntervalMs: 60 * 60 * 1000,
      startupJitterMaxMs: 300_000,
    },
  );
  return {
    service,
    check,
    notifications,
    deliveredNotices,
    timer,
    timeouts,
    intervals,
    startUpdate,
  };
}

describe("UpdateDiscoveryService", () => {
  it("uses inclusive five-minute startup jitter and a 60-minute cadence", async () => {
    const h = harness();
    h.service.onModuleInit();

    expect(h.timeouts[0].delay).toBe(300_000);
    h.timeouts[0].callback();
    await vi.waitFor(() => expect(h.check.execute).toHaveBeenCalledTimes(1));
    expect(h.intervals[0].delay).toBe(60 * 60 * 1000);
  });

  it("coalesces concurrent checks, emits a typed notice, and never starts an update", async () => {
    const h = harness({
      kind: "available",
      installed: available.artifact,
      available,
    });
    let resolveCheck!: (value: UpdateCheck) => void;
    vi.mocked(h.check.execute).mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );

    const first = h.service.checkNow();
    const second = h.service.checkNow();
    resolveCheck({
      kind: "available",
      installed: available.artifact,
      available,
    });
    await Promise.all([first, second]);

    expect(h.check.execute).toHaveBeenCalledTimes(1);
    expect(h.startUpdate).not.toHaveBeenCalled();
    expect(h.deliveredNotices).toEqual([
      {
        kind: "release-available",
        version: "1.4.3",
        targetName: "linux-armv7-glibc",
        commit: available.artifact.commit,
      },
    ]);
  });

  it("keeps routine pre-expiry network failures silent", async () => {
    const h = harness({
      kind: "failure",
      failure: { code: "network-unavailable" },
    });

    await h.service.checkNow();

    expect(h.check.isFailureNotificationDue).not.toHaveBeenCalled();
    expect(h.notifications.deliver).not.toHaveBeenCalled();
  });

  it("acknowledges an available notice only after at least one delivery", async () => {
    const h = harness({
      kind: "available",
      installed: available.artifact,
      available,
    });
    const order: string[] = [];
    vi.mocked(h.notifications.deliver).mockImplementation(async () => {
      order.push("deliver");
      return { delivered: 1 };
    });
    vi.mocked(h.check.acknowledgeAvailableNotification).mockImplementation(
      async () => {
        order.push("acknowledge");
      },
    );

    await h.service.checkNow();

    expect(order).toEqual(["deliver", "acknowledge"]);
    expect(h.check.acknowledgeAvailableNotification).toHaveBeenCalledWith(
      available,
      new Date("2030-01-15T12:00:00.000Z"),
    );
  });

  it("leaves the available-notice allowance unconsumed when delivery reaches nobody", async () => {
    const h = harness({
      kind: "available",
      installed: available.artifact,
      available,
    });
    vi.mocked(h.notifications.deliver).mockResolvedValue({ delivered: 0 });

    await h.service.checkNow();

    expect(h.check.acknowledgeAvailableNotification).not.toHaveBeenCalled();
  });

  it("acknowledges a non-routine failure only after delivery", async () => {
    const h = harness();

    await h.service.checkNow();

    expect(h.deliveredNotices).toEqual([
      { kind: "discovery-failure", code: "signature-invalid" },
    ]);
    expect(h.check.acknowledgeFailureNotification).toHaveBeenCalledWith(
      "signature-invalid",
      new Date("2030-01-15T12:00:00.000Z"),
    );
  });

  it("leaves the failure allowance unconsumed after zero or failed delivery", async () => {
    const h = harness();
    vi.mocked(h.notifications.deliver)
      .mockResolvedValueOnce({ delivered: 0 })
      .mockRejectedValueOnce(new Error("telegram unavailable"));

    await h.service.checkNow();
    await expect(h.service.checkNow()).rejects.toThrow("telegram unavailable");

    expect(h.check.acknowledgeFailureNotification).not.toHaveBeenCalled();
  });

  it("suppresses an in-process duplicate after delivery if durable acknowledgement fails", async () => {
    const h = harness();
    vi.mocked(h.check.acknowledgeFailureNotification).mockRejectedValue(
      new Error("trust-state-lost"),
    );

    await expect(h.service.checkNow()).rejects.toThrow("trust-state-lost");
    await h.service.checkNow();

    expect(h.notifications.deliver).toHaveBeenCalledTimes(1);
  });
});
