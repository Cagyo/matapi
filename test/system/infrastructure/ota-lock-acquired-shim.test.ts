import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  OTA_LOCK_ACQUIRED_MARKER,
  runOtaLockAcquiredShim,
  type OtaLockAcquiredShimChild,
  type OtaLockAcquiredShimDependencies,
} from "../../../src/system/infrastructure/ota-lock-acquired-shim";

const OPERATION_ID = Buffer.alloc(16, 1).toString("base64url");

class FakeUpdater extends EventEmitter implements OtaLockAcquiredShimChild {}

function dependencies() {
  const child = new FakeUpdater();
  const actions: string[] = [];
  const spawn = vi.fn(() => {
    actions.push("spawn");
    return child;
  });
  const deps: OtaLockAcquiredShimDependencies = {
    writeAll: (fd, bytes) =>
      actions.push(`write:${fd}:${bytes.toString("utf8")}`),
    close: (fd) => actions.push(`close:${fd}`),
    spawn,
    nodeExecutable: "/usr/bin/node",
    updaterEntry:
      "/opt/home-worker/current/dist/system/infrastructure/ota-updater.js",
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
  return { child, actions, spawn, deps };
}

describe("runOtaLockAcquiredShim", () => {
  it("emits and closes fixed fd4 provenance before fixed updater spawn", async () => {
    const state = dependencies();
    const pending = runOtaLockAcquiredShim(
      ["--operation-id", OPERATION_ID, "--handshake-fd", "3"],
      state.deps,
    );

    expect(state.actions.slice(0, 3)).toEqual([
      `write:4:${OTA_LOCK_ACQUIRED_MARKER}`,
      "close:4",
      "spawn",
    ]);
    expect(state.spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      [
        "/opt/home-worker/current/dist/system/infrastructure/ota-updater.js",
        "--operation-id",
        OPERATION_ID,
        "--handshake-fd",
        "3",
      ],
      {
        shell: false,
        stdio: ["ignore", "ignore", "ignore", 3],
        env: expect.not.objectContaining({
          TELEGRAM_BOT_TOKEN: expect.anything(),
          NODE_OPTIONS: expect.anything(),
        }),
      },
    );
    expect(state.spawn.mock.calls[0][2].env).toMatchObject({
      HOME_WORKER_UPDATE_RUNTIME_LIBC_VERSION: "2.28",
    });
    expect(Object.isFrozen(state.spawn.mock.calls[0][2].env)).toBe(true);
    expect(state.actions).toContain("close:3");

    state.child.emit("close", 0, null);
    await expect(pending).resolves.toBe(0);
  });

  it("remaps updater exit 73 to a non-contention code", async () => {
    const state = dependencies();
    const pending = runOtaLockAcquiredShim(
      ["--operation-id", OPERATION_ID, "--handshake-fd", "3"],
      state.deps,
    );

    state.child.emit("close", 73, null);

    await expect(pending).resolves.toBe(74);
  });

  it("emits provenance first but refuses malformed dynamic arguments", async () => {
    const state = dependencies();

    await expect(
      runOtaLockAcquiredShim(["--operation-id", "../escape"], state.deps),
    ).resolves.toBe(75);
    expect(state.actions.slice(0, 2)).toEqual([
      `write:4:${OTA_LOCK_ACQUIRED_MARKER}`,
      "close:4",
    ]);
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("does not spawn when the provenance marker cannot be emitted", async () => {
    const state = dependencies();
    state.deps.writeAll = () => {
      throw new Error("fd4 failed");
    };

    await expect(
      runOtaLockAcquiredShim(
        ["--operation-id", OPERATION_ID, "--handshake-fd", "3"],
        state.deps,
      ),
    ).resolves.toBe(75);
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("maps updater signals and spawn errors to maintenance exit", async () => {
    const signaled = dependencies();
    const signalPending = runOtaLockAcquiredShim(
      ["--operation-id", OPERATION_ID, "--handshake-fd", "3"],
      signaled.deps,
    );
    signaled.child.emit("close", null, "SIGTERM");
    await expect(signalPending).resolves.toBe(75);

    const failed = dependencies();
    failed.deps.spawn = () => {
      throw new Error("spawn failed");
    };
    await expect(
      runOtaLockAcquiredShim(
        ["--operation-id", OPERATION_ID, "--handshake-fd", "3"],
        failed.deps,
      ),
    ).resolves.toBe(75);
  });
});
