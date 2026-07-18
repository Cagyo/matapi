import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  OTA_LOCK_ACQUIRED_MARKER,
  OTA_LOCK_CONFLICT_MARKER,
  runOtaLockAcquiredShim,
  type OtaLockAcquiredShimChild,
  type OtaLockAcquiredShimDependencies,
} from "../../../src/system/infrastructure/ota-lock-acquired-shim";

const OPERATION_ID = Buffer.alloc(16, 1).toString("base64url");
const SHIM_ARGS = [
  "--operation-id",
  OPERATION_ID,
  "--handshake-fd",
  "3",
] as const;

class FakeChild extends EventEmitter implements OtaLockAcquiredShimChild {
  readonly exitCode = null;
  readonly signalCode = null;
  readonly kill = vi.fn(() => true);
}

function dependencies() {
  const helper = new FakeChild();
  const updater = new FakeChild();
  const actions: string[] = [];
  const signalListeners: Partial<Record<"SIGTERM" | "SIGINT", () => void>> = {};
  const spawn = vi.fn((file: string) => {
    actions.push(`spawn:${file}`);
    return file === "/usr/bin/flock" ? helper : updater;
  });
  const deps: OtaLockAcquiredShimDependencies = {
    assertLockLease: (fd) => actions.push(`validate:${fd}`),
    onSignal: (signal, listener) => {
      actions.push(`on:${signal}`);
      signalListeners[signal] = listener;
    },
    removeSignal: (signal, listener) => {
      actions.push(`off:${signal}`);
      if (signalListeners[signal] === listener) delete signalListeners[signal];
    },
    writeAll: (fd, bytes) =>
      actions.push(`write:${fd}:${bytes.toString("utf8")}`),
    close: (fd) => actions.push(`close:${fd}`),
    spawn,
    flockPath: "/usr/bin/flock",
    nodeExecutable: "/usr/bin/node",
    updaterEntry:
      "/opt/home-worker/current/dist/system/infrastructure/ota-updater.entry.js",
    sourceEnvironment: {
      PATH: "/usr/bin:/bin",
      NODE_ENV: "production",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      HOME_WORKER_UPDATE_FEED_URL:
        "https://updates.example.test/home-worker/stable/linux-armv7-glibc/update-envelope.json",
      HOME_WORKER_UPDATE_TRUST_DIR: "/etc/home-worker/update-keys",
      HOME_WORKER_UPDATE_CHANNEL: "stable",
      HOME_WORKER_UPDATE_TARGET: "linux-armv7-glibc",
      HOME_WORKER_UPDATE_LOCK_PATH: "/run/home-worker/ota.lock",
      HOME_WORKER_UPDATE_REQUEST_DIR: "/run/home-worker/requests",
      HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES: "104857600",
      HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES: "536870912",
      HOME_WORKER_UPDATE_MAX_FILES: "20000",
      HOME_WORKER_UPDATE_HEALTH_SECONDS: "60",
      HOME_WORKER_UPDATE_RUNTIME_LIBC_VERSION: "2.28",
      TELEGRAM_BOT_TOKEN: "must-not-reach-updater",
      NODE_OPTIONS: "--require=/tmp/evil.js",
    },
  };
  return {
    helper,
    updater,
    actions,
    spawn,
    deps,
    signalListeners,
  };
}

async function acquireLock(
  state: ReturnType<typeof dependencies>,
): Promise<void> {
  state.helper.emit("close", 0, null);
  await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledTimes(2));
}

describe("runOtaLockAcquiredShim", () => {
  it("locks only inherited fd5 before emitting acquired and supervising updater", async () => {
    const state = dependencies();
    const pending = runOtaLockAcquiredShim(SHIM_ARGS, state.deps);

    expect(state.actions.slice(0, 4)).toEqual([
      "on:SIGTERM",
      "on:SIGINT",
      "validate:5",
      "spawn:/usr/bin/flock",
    ]);
    expect(state.spawn).toHaveBeenNthCalledWith(
      1,
      "/usr/bin/flock",
      ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "5"],
      {
        shell: false,
        stdio: ["ignore", "ignore", "ignore", "ignore", "ignore", 5],
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      },
    );
    expect(state.actions).not.toContainEqual(
      expect.stringContaining(OTA_LOCK_ACQUIRED_MARKER),
    );

    await acquireLock(state);

    expect(state.actions).toContain(`write:4:${OTA_LOCK_ACQUIRED_MARKER}`);
    expect(state.spawn).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/node",
      [
        "/opt/home-worker/current/dist/system/infrastructure/ota-updater.entry.js",
        "--operation-id",
        OPERATION_ID,
        "--handshake-fd",
        "3",
      ],
      {
        shell: false,
        stdio: ["ignore", "ignore", "ignore", 3, "ignore", 5],
        env: expect.not.objectContaining({
          TELEGRAM_BOT_TOKEN: expect.anything(),
          NODE_OPTIONS: expect.anything(),
        }),
      },
    );
    expect(state.actions).toContain("close:3");
    expect(state.actions).not.toContain("close:5");

    state.updater.emit("close", 0, null);
    await expect(pending).resolves.toBe(0);
  });

  it("emits strict conflict and never spawns updater after helper conflict", async () => {
    const state = dependencies();
    const pending = runOtaLockAcquiredShim(SHIM_ARGS, state.deps);

    state.helper.emit("close", 73, null);

    await expect(pending).resolves.toBe(73);
    expect(state.actions).toContain(`write:4:${OTA_LOCK_CONFLICT_MARKER}`);
    expect(state.actions).toContain("close:4");
    expect(state.spawn).toHaveBeenCalledTimes(1);
  });

  it("emits no control frame when helper fails without a conflict close", async () => {
    const state = dependencies();
    const pending = runOtaLockAcquiredShim(SHIM_ARGS, state.deps);

    state.helper.emit("error", new Error("helper failure"));
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(state.actions).not.toContainEqual(
      expect.stringMatching(/^write:4:/),
    );

    state.helper.emit("close", 1, null);
    await expect(pending).resolves.toBe(75);
    expect(state.actions).not.toContainEqual(
      expect.stringMatching(/^write:4:/),
    );
  });

  it("installs abort handlers before helper spawn and refuses work after that race", async () => {
    const state = dependencies();
    state.deps.onSignal = (signal, listener) => {
      state.actions.push(`on:${signal}`);
      state.signalListeners[signal] = listener;
      if (signal === "SIGTERM") listener();
    };

    await expect(runOtaLockAcquiredShim(SHIM_ARGS, state.deps)).resolves.toBe(
      75,
    );
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.actions).not.toContainEqual(
      expect.stringMatching(/^write:4:/),
    );
  });

  it("waits for delayed updater close after child error", async () => {
    const state = dependencies();
    const pending = runOtaLockAcquiredShim(SHIM_ARGS, state.deps);
    await acquireLock(state);

    state.updater.emit("error", new Error("kill failure while still alive"));
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(state.actions).not.toContain("close:5");

    state.updater.emit("close", null, "SIGKILL");
    await expect(pending).resolves.toBe(75);
  });

  it("terminates and waits for updater when closing shim fd3 fails", async () => {
    const state = dependencies();
    state.deps.close = (fd) => {
      state.actions.push(`close:${fd}`);
      if (fd === 3) throw new Error("close fd3 failed");
    };
    const pending = runOtaLockAcquiredShim(SHIM_ARGS, state.deps);
    await acquireLock(state);

    expect(state.updater.kill).toHaveBeenCalledWith("SIGTERM");
    state.updater.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toBe(75);
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "keeps shim alive on %s until updater cleanup closes",
    async (signal) => {
      const state = dependencies();
      const pending = runOtaLockAcquiredShim(SHIM_ARGS, state.deps);
      await acquireLock(state);

      state.signalListeners[signal]?.();
      expect(state.updater.kill).toHaveBeenCalledWith(signal);
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      state.updater.emit("close", 0, null);
      await expect(pending).resolves.toBe(75);
    },
  );

  it("rejects malformed arguments and invalid fd5 without helper or control", async () => {
    for (const scenario of [
      {
        args: SHIM_ARGS as readonly string[],
        configure: (state: ReturnType<typeof dependencies>) => {
          state.deps.assertLockLease = () => {
            throw new Error("EBADF");
          };
        },
      },
      {
        args: ["--operation-id", "../escape"] as readonly string[],
        configure: (_state: ReturnType<typeof dependencies>) => undefined,
      },
    ]) {
      const state = dependencies();
      scenario.configure(state);
      await expect(
        runOtaLockAcquiredShim(scenario.args, state.deps),
      ).resolves.toBe(75);
      expect(state.spawn).not.toHaveBeenCalled();
      expect(state.actions).not.toContainEqual(
        expect.stringMatching(/^write:4:/),
      );
    }
  });
});
