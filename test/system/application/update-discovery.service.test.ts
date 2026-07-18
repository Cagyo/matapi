import { describe, expect, it, vi } from "vitest";
import type { CheckForUpdatesUseCase } from "../../../src/system/application/check-for-updates.use-case";
import { UpdateDiscoveryService } from "../../../src/system/application/update-discovery.service";
import type {
  CheckedReleaseIdentity,
  UpdateCheck,
} from "../../../src/system/domain/ota-contracts";
import type { NotifierPort } from "../../../src/events/domain/ports/notifier.port";
import type { UpdateDiscoveryClockPort } from "../../../src/system/application/ports/update-discovery-clock.port";
import type { UpdateDiscoveryRandomPort } from "../../../src/system/application/ports/update-discovery-random.port";
import type { UpdateDiscoveryTimerPort } from "../../../src/system/application/ports/update-discovery-timer.port";

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
    claimAvailableNotification: vi.fn().mockResolvedValue(true),
    claimFailureNotification: vi.fn().mockResolvedValue(true),
    startUpdate,
  } as unknown as CheckForUpdatesUseCase;
  const notifier: NotifierPort = {
    isReady: vi.fn().mockReturnValue(true),
    notify: vi.fn().mockResolvedValue(undefined),
    notifyUser: vi.fn(),
    notifyUserPhoto: vi.fn(),
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
    notifier,
    clock,
    timer,
    random,
    {
      pollIntervalMs: 60 * 60 * 1000,
      startupJitterMaxMs: 300_000,
    },
  );
  return { service, check, notifier, timer, timeouts, intervals, startUpdate };
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

  it("coalesces concurrent checks and never starts an update", async () => {
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
    expect(h.notifier.notify).toHaveBeenCalledTimes(1);
  });

  it("keeps routine pre-expiry network failures silent", async () => {
    const h = harness({
      kind: "failure",
      failure: { code: "network-unavailable" },
    });

    await h.service.checkNow();

    expect(h.check.claimFailureNotification).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });

  it("notifies once per available artifact and distinct failure per UTC day", async () => {
    const h = harness({
      kind: "available",
      installed: available.artifact,
      available,
    });
    vi.mocked(h.check.claimAvailableNotification)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await h.service.checkNow();
    await h.service.checkNow();
    expect(h.notifier.notify).toHaveBeenCalledTimes(1);

    vi.mocked(h.check.execute).mockResolvedValue({
      kind: "failure",
      failure: { code: "signature-invalid" },
    });
    vi.mocked(h.check.claimFailureNotification)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await h.service.checkNow();
    await h.service.checkNow();
    expect(h.notifier.notify).toHaveBeenCalledTimes(2);
    expect(h.check.claimFailureNotification).toHaveBeenNthCalledWith(
      1,
      "signature-invalid",
      new Date("2030-01-15T12:00:00.000Z"),
    );
  });

  it("rate-limits trust-state failures in memory when the durable ledger is unavailable", async () => {
    const h = harness({
      kind: "failure",
      failure: { code: "trust-state-lost" },
    });
    vi.mocked(h.check.claimFailureNotification).mockRejectedValue(
      new Error("trust-state-lost"),
    );

    await h.service.checkNow();
    await h.service.checkNow();

    expect(h.notifier.notify).toHaveBeenCalledTimes(1);
  });
});
