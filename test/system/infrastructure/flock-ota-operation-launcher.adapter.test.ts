import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseOtaOperationRequest,
  type CheckedReleaseIdentity,
  type OtaOperationRequest,
} from "../../../src/system/domain/ota-contracts";
import {
  FlockOtaOperationLauncherAdapter,
  operationRequestPath,
  type OtaLauncherChild,
  type OtaLauncherDependencies,
  type OtaLauncherFileHandle,
  type OtaLauncherFileSystem,
  type OtaLauncherTimer,
} from "../../../src/system/infrastructure/flock-ota-operation-launcher.adapter";
import type { OtaConfig } from "../../../src/system/infrastructure/ota-discovery-config.loader";

const ACCEPTED_AT = "2030-01-02T03:04:05.006Z";
const OPERATION_ID = Buffer.alloc(16, 1).toString("base64url");

function checkedReleaseFixture(): CheckedReleaseIdentity {
  return {
    artifact: {
      version: "1.4.2",
      commit: "0123456789abcdef0123456789abcdef01234567",
      targetName: "linux-armv7-glibc",
      target: {
        platform: "linux",
        arch: "arm",
        libc: "glibc",
        libcMinVersion: "2.28",
        nodeModulesAbi: "115",
      },
      url: "https://updates.example.test/home-worker/releases/home-worker-1.4.2.tar.gz",
      format: "tar.gz",
      size: 10,
      expandedSize: 20,
      maxPreparedSize: 30,
      maxPreparedFiles: 40,
      fileCount: 2,
      sha256: "a".repeat(64),
    },
    metadata: {
      metadataVersion: 42,
      channel: "stable",
      payloadSha256: "b".repeat(64),
      publishedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-31T00:00:00.000Z",
    },
  };
}

function config(): OtaConfig {
  const policy = {
    feedUrl:
      "https://updates.example.test/home-worker/stable/linux-armv7-glibc/update-envelope.json",
    channel: "stable" as const,
    target: {
      targetName: "linux-armv7-glibc" as const,
      platform: "linux" as const,
      arch: "arm" as const,
      libc: "glibc" as const,
      libcVersion: "2.28",
      nodeModulesAbi: "115",
    },
    runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" as const },
    limits: {
      maxArtifactBytes: 100 * 1024 * 1024,
      maxExpandedBytes: 512 * 1024 * 1024,
      maxPreparedBytes: 1024 * 1024 * 1024,
      maxPreparedFiles: 200_000,
      maxFiles: 20_000,
    },
  };
  return {
    mode: "real",
    feedUrl: policy.feedUrl,
    trustDirectory: "/etc/home-worker/update-keys",
    policy,
    checkOptions: {
      feedUrl: policy.feedUrl,
      maxEnvelopeBytes: 96 * 1024,
      timeouts: {
        connectMs: 10_000,
        firstByteMs: 10_000,
        idleMs: 15_000,
        totalMs: 60_000,
      },
    },
    discoveryOptions: {
      pollIntervalMs: 60 * 60 * 1000,
      startupJitterMaxMs: 300_000,
    },
    updater: { healthSeconds: 60 },
    launcher: {
      flockPath: "/usr/bin/flock",
      nodeExecutable: "/usr/bin/node",
      lockPath: "/run/home-worker/ota.lock",
      requestDirectory: "/run/home-worker/requests",
      updaterEntry:
        "/opt/home-worker/current/dist/system/infrastructure/ota-updater.js",
      conflictExitCode: 73,
      handshakeTimeoutMs: 10_000,
      terminateGraceMs: 2_000,
      killWaitMs: 2_000,
      policy,
      environment: {
        PATH: "/usr/bin:/bin",
        NODE_ENV: "production",
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        HOME_WORKER_UPDATE_FEED_URL: policy.feedUrl,
        HOME_WORKER_UPDATE_TRUST_DIR: "/etc/home-worker/update-keys",
        HOME_WORKER_UPDATE_CHANNEL: "stable",
        HOME_WORKER_UPDATE_TARGET: "linux-armv7-glibc",
        HOME_WORKER_UPDATE_LOCK_PATH: "/run/home-worker/ota.lock",
        HOME_WORKER_UPDATE_REQUEST_DIR: "/run/home-worker/requests",
        HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES: String(
          policy.limits.maxArtifactBytes,
        ),
        HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES: String(
          policy.limits.maxExpandedBytes,
        ),
        HOME_WORKER_UPDATE_MAX_FILES: String(policy.limits.maxFiles),
        HOME_WORKER_UPDATE_HEALTH_SECONDS: "60",
      },
    },
  };
}

class FakeChild extends EventEmitter implements OtaLauncherChild {
  readonly pid = 4242;
  readonly handshake = new PassThrough();
  readonly stdio = [null, null, null, this.handshake] as const;
  readonly unref = vi.fn();
}

interface FileSystemFake extends OtaLauncherFileSystem {
  calls: string[];
  openCalls: { path: string; flags: number; mode?: number }[];
  bytes?: Buffer;
  finalPath?: string;
  failWrite?: boolean;
}

function fileSystemFake(): FileSystemFake {
  const calls: string[] = [];
  const fake: FileSystemFake = {
    calls,
    openCalls: [],
    async open(path, flags, mode) {
      fake.openCalls.push({ path, flags, mode });
      const isDirectory = path === config().launcher.requestDirectory;
      calls.push(isDirectory ? "open-parent" : "open-temp");
      const handle: OtaLauncherFileHandle = {
        async writeFile(bytes) {
          calls.push("write");
          if (fake.failWrite) throw new Error("write failed");
          fake.bytes = Buffer.from(bytes);
        },
        async sync() {
          calls.push(isDirectory ? "sync-parent" : "sync-file");
        },
        async close() {
          calls.push(isDirectory ? "close-parent" : "close-file");
        },
      };
      return handle;
    },
    async rename(_from, to) {
      calls.push("rename");
      fake.finalPath = to;
    },
    async unlink() {
      calls.push("unlink");
    },
  };
  return fake;
}

interface ManualTimer extends OtaLauncherTimer {
  pending: { callback: () => void; delayMs: number; active: boolean }[];
  fireNext(): void;
}

function manualTimer(): ManualTimer {
  const pending: ManualTimer["pending"] = [];
  return {
    pending,
    setTimeout(callback, delayMs) {
      const handle = { callback, delayMs, active: true };
      pending.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      (handle as ManualTimer["pending"][number]).active = false;
    },
    fireNext() {
      const handle = pending.find((candidate) => candidate.active);
      if (!handle) throw new Error("no active timer");
      handle.active = false;
      handle.callback();
    },
  };
}

interface Harness {
  launcher: FlockOtaOperationLauncherAdapter;
  child: FakeChild;
  fs: FileSystemFake;
  timer: ManualTimer;
  spawn: ReturnType<typeof vi.fn>;
  signals: { pid: number; signal: NodeJS.Signals }[];
}

function harness(overrides: Partial<OtaLauncherDependencies> = {}): Harness {
  const child = new FakeChild();
  const fs = fileSystemFake();
  const timer = manualTimer();
  const spawn = vi.fn(() => child);
  const signals: Harness["signals"] = [];
  const dependencies: OtaLauncherDependencies = {
    fs,
    spawn,
    randomBytes: (size) => Buffer.alloc(size, size === 16 ? 1 : 2),
    now: () => new Date(ACCEPTED_AT),
    timer,
    signalProcessGroup: (pid, signal) => signals.push({ pid, signal }),
    ...overrides,
  };
  return {
    launcher: new FlockOtaOperationLauncherAdapter(config(), dependencies),
    child,
    fs,
    timer,
    spawn,
    signals,
  };
}

async function waitForSpawn(state: Harness): Promise<OtaOperationRequest> {
  await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledTimes(1));
  if (!state.fs.bytes) throw new Error("missing request bytes");
  return parseOtaOperationRequest(state.fs.bytes);
}

function receipt(
  request: OtaOperationRequest,
  override: Partial<
    Record<keyof OtaOperationRequest | "receiptGeneration", unknown>
  > = {},
): string {
  return `${JSON.stringify({
    schemaVersion: override.schemaVersion ?? 1,
    operationId: override.operationId ?? request.operationId,
    kind: override.kind ?? request.kind,
    acceptedAt: override.acceptedAt ?? request.acceptedAt,
    requestSha256: override.requestSha256 ?? request.requestSha256,
    receiptGeneration: override.receiptGeneration ?? 7,
  })}\n`;
}

async function expectMaintenanceAfterClose(
  state: Harness,
  pending: Promise<unknown>,
): Promise<void> {
  await vi.waitFor(() =>
    expect(state.signals).toContainEqual({ pid: -4242, signal: "SIGTERM" }),
  );
  state.child.emit("close", null, "SIGTERM");
  await expect(pending).resolves.toEqual({
    kind: "rejected",
    failure: { code: "maintenance-required" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FlockOtaOperationLauncherAdapter", () => {
  it("durably persists the exact displayed identity before fixed no-shell spawn", async () => {
    const state = harness();
    const expected = checkedReleaseFixture();
    const pending = state.launcher.startUpdate(expected);
    const request = await waitForSpawn(state);

    expect(request.expected).toEqual(expected);
    expect(request.expected).not.toBe(expected);
    expect(request).toMatchObject({
      schemaVersion: 1,
      operationId: OPERATION_ID,
      kind: "update",
      acceptedAt: ACCEPTED_AT,
      requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(Object.keys(JSON.parse(state.fs.bytes!.toString("utf8")))).toEqual([
      "schemaVersion",
      "operationId",
      "kind",
      "expected",
      "acceptedAt",
      "requestSha256",
    ]);
    expect(state.fs.finalPath).toBe(
      `/run/home-worker/requests/${OPERATION_ID}.json`,
    );
    expect(state.fs.calls.slice(0, 8)).toEqual([
      "open-temp",
      "write",
      "sync-file",
      "close-file",
      "rename",
      "open-parent",
      "sync-parent",
      "close-parent",
    ]);
    expect(state.fs.openCalls[0]).toMatchObject({ mode: 0o600 });
    expect(state.fs.openCalls[0].flags).toBe(
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
    );
    expect(state.spawn).toHaveBeenCalledWith(
      "/usr/bin/flock",
      [
        "--no-fork",
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        "73",
        "/run/home-worker/ota.lock",
        "/usr/bin/node",
        "/opt/home-worker/current/dist/system/infrastructure/ota-updater.js",
        "--operation-id",
        OPERATION_ID,
        "--handshake-fd",
        "3",
      ],
      {
        detached: true,
        shell: false,
        stdio: ["ignore", "ignore", "ignore", "pipe"],
        env: config().launcher.environment,
      },
    );
    expect(Object.keys(state.spawn.mock.calls[0][2].env)).toEqual(
      Object.keys(config().launcher.environment),
    );

    state.child.handshake.end(receipt(request));
    await expect(pending).resolves.toMatchObject({ kind: "started" });
  });

  it("does not spawn until both the request file and parent directory are synced", async () => {
    const fs = fileSystemFake();
    let releaseParentSync!: () => void;
    const parentSyncGate = new Promise<void>((resolve) => {
      releaseParentSync = resolve;
    });
    const originalOpen = fs.open.bind(fs);
    fs.open = async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (path === config().launcher.requestDirectory) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          await originalSync();
          await parentSyncGate;
        };
      }
      return handle;
    };
    const state = harness({ fs });
    const pending = state.launcher.startUpdate(checkedReleaseFixture());

    await vi.waitFor(() => expect(fs.calls).toContain("sync-parent"));
    expect(state.spawn).not.toHaveBeenCalled();

    releaseParentSync();
    await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledOnce());
    const request = parseOtaOperationRequest(fs.bytes!);
    state.child.handshake.end(receipt(request));
    await expect(pending).resolves.toMatchObject({ kind: "started" });
  });

  it("rejects request identity mutation against the canonical authorization digest", async () => {
    const state = harness();
    const pending = state.launcher.startUpdate(checkedReleaseFixture());
    const request = await waitForSpawn(state);
    const mutated = JSON.parse(state.fs.bytes!.toString("utf8"));
    mutated.expected.artifact.sha256 = "f".repeat(64);

    expect(() =>
      parseOtaOperationRequest(Buffer.from(JSON.stringify(mutated), "utf8")),
    ).toThrow(/requestSha256/);

    state.child.handshake.end(receipt(request));
    await expect(pending).resolves.toMatchObject({ kind: "started" });
  });

  it("does not report started before a complete receipt and fd EOF", async () => {
    const state = harness();
    const pending = state.launcher.startUpdate(checkedReleaseFixture());
    const request = await waitForSpawn(state);
    const frame = receipt(request);
    state.child.handshake.write(frame.slice(0, 20));

    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    state.child.handshake.write(frame.slice(20));
    await Promise.resolve();
    expect(settled).toBe(false);

    state.child.handshake.end();
    await expect(pending).resolves.toEqual({
      kind: "started",
      receipt: {
        schemaVersion: 1,
        operationId: OPERATION_ID,
        kind: "update",
        acceptedAt: ACCEPTED_AT,
        requestSha256: request.requestSha256,
        receiptGeneration: 7,
      },
    });
    expect(state.child.unref).toHaveBeenCalledOnce();
  });

  it("writes rollback with null expected identity", async () => {
    const state = harness();
    const pending = state.launcher.startRollback();
    const request = await waitForSpawn(state);

    expect(request).toMatchObject({ kind: "rollback", expected: null });
    state.child.handshake.end(receipt(request));
    await expect(pending).resolves.toMatchObject({ kind: "started" });
  });

  it("rejects hostile operation IDs before deriving a request path", () => {
    for (const id of [
      "../escape",
      `${OPERATION_ID}.json`,
      `${OPERATION_ID.slice(0, -1)}R`,
    ]) {
      expect(() => operationRequestPath(config().launcher, id)).toThrow();
    }
    expect(operationRequestPath(config().launcher, OPERATION_ID)).toBe(
      `/run/home-worker/requests/${OPERATION_ID}.json`,
    );
  });

  it("rejects a checked identity outside the configured target, origin, or bounds", async () => {
    const mutations: CheckedReleaseIdentity[] = [
      {
        ...checkedReleaseFixture(),
        artifact: {
          ...checkedReleaseFixture().artifact,
          targetName: "linux-arm64-glibc",
          target: { ...checkedReleaseFixture().artifact.target, arch: "arm64" },
        },
      },
      {
        ...checkedReleaseFixture(),
        artifact: {
          ...checkedReleaseFixture().artifact,
          url: "https://evil.example/home-worker-1.4.2.tar.gz",
        },
      },
      {
        ...checkedReleaseFixture(),
        artifact: {
          ...checkedReleaseFixture().artifact,
          size: 100 * 1024 * 1024 + 1,
        },
      },
    ];

    for (const expected of mutations) {
      const state = harness();
      await expect(state.launcher.startUpdate(expected)).resolves.toEqual({
        kind: "rejected",
        failure: { code: "maintenance-required" },
      });
      expect(state.spawn).not.toHaveBeenCalled();
    }
  });

  it("maps only the dedicated pre-frame flock conflict to operation-in-progress", async () => {
    const conflict = harness();
    const conflictPending = conflict.launcher.startUpdate(
      checkedReleaseFixture(),
    );
    await waitForSpawn(conflict);
    const conflictEof = new Promise<void>((resolve) =>
      conflict.child.handshake.once("end", resolve),
    );
    conflict.child.handshake.end();
    await conflictEof;
    conflict.child.emit("exit", 73, null);
    conflict.child.emit("close", 73, null);
    await expect(conflictPending).resolves.toEqual({
      kind: "rejected",
      failure: { code: "operation-in-progress" },
    });

    const generic = harness();
    const genericPending = generic.launcher.startUpdate(
      checkedReleaseFixture(),
    );
    await waitForSpawn(generic);
    const genericEof = new Promise<void>((resolve) =>
      generic.child.handshake.once("end", resolve),
    );
    generic.child.handshake.end();
    await genericEof;
    generic.child.emit("exit", 1, null);
    generic.child.emit("close", 1, null);
    await expect(genericPending).resolves.toEqual({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });
  });

  it("maps synchronous and emitted spawn failures to maintenance-required", async () => {
    const sync = harness({
      spawn: () => {
        throw new Error("spawn failed");
      },
    });
    await expect(
      sync.launcher.startUpdate(checkedReleaseFixture()),
    ).resolves.toEqual({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });

    const emitted = harness();
    const pending = emitted.launcher.startUpdate(checkedReleaseFixture());
    await waitForSpawn(emitted);
    emitted.child.emit("error", new Error("spawn failed"));
    emitted.child.emit("close", null, null);
    await expect(pending).resolves.toEqual({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });
  });

  it.each([
    [
      "duplicate key",
      (request: OtaOperationRequest) =>
        receipt(request).replace(
          '"kind":"update"',
          '"kind":"update","kind":"update"',
        ),
    ],
    [
      "multiple frames",
      (request: OtaOperationRequest) =>
        `${receipt(request)}${receipt(request)}`,
    ],
    [
      "trailing bytes",
      (request: OtaOperationRequest) => `${receipt(request)}x`,
    ],
    [
      "truncated frame",
      (request: OtaOperationRequest) => receipt(request).slice(0, -1),
    ],
    [
      "mismatched digest",
      (request: OtaOperationRequest) =>
        receipt(request, { requestSha256: "f".repeat(64) }),
    ],
    [
      "zero generation",
      (request: OtaOperationRequest) =>
        receipt(request, { receiptGeneration: 0 }),
    ],
  ] as const)("rejects a %s receipt", async (_label, frame) => {
    const state = harness();
    const pending = state.launcher.startUpdate(checkedReleaseFixture());
    const request = await waitForSpawn(state);
    state.child.handshake.end(frame(request));
    await expectMaintenanceAfterClose(state, pending);
  });

  it("rejects fatal UTF-8 and receipts larger than 1 KiB", async () => {
    const invalidUtf8 = harness();
    const utf8Pending = invalidUtf8.launcher.startUpdate(
      checkedReleaseFixture(),
    );
    await waitForSpawn(invalidUtf8);
    invalidUtf8.child.handshake.end(Buffer.from([0xff, 0x0a]));
    await expectMaintenanceAfterClose(invalidUtf8, utf8Pending);

    const oversized = harness();
    const oversizedPending = oversized.launcher.startUpdate(
      checkedReleaseFixture(),
    );
    await waitForSpawn(oversized);
    oversized.child.handshake.end(Buffer.alloc(1025, 0x61));
    await expectMaintenanceAfterClose(oversized, oversizedPending);
  });

  it("drains a valid receipt after exit and lets it win a later child close", async () => {
    const state = harness();
    const pending = state.launcher.startUpdate(checkedReleaseFixture());
    const request = await waitForSpawn(state);

    state.child.emit("exit", 1, null);
    state.child.handshake.end(receipt(request));
    await expect(pending).resolves.toMatchObject({ kind: "started" });
    state.child.emit("close", 1, null);
  });

  it("on timeout terminates, waits, escalates, and ignores a late valid frame", async () => {
    const state = harness();
    const pending = state.launcher.startUpdate(checkedReleaseFixture());
    const request = await waitForSpawn(state);

    state.timer.fireNext();
    expect(state.signals).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
    state.child.handshake.end(receipt(request));
    await Promise.resolve();

    state.timer.fireNext();
    expect(state.signals).toEqual([
      { pid: -4242, signal: "SIGTERM" },
      { pid: -4242, signal: "SIGKILL" },
    ]);
    state.child.emit("close", null, "SIGKILL");
    await expect(pending).resolves.toEqual({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });
    expect(state.child.unref).not.toHaveBeenCalled();
  });

  it("uses the same terminate-and-reap path for caller abort", async () => {
    const state = harness();
    const controller = new AbortController();
    const pending = state.launcher.startUpdate(
      checkedReleaseFixture(),
      controller.signal,
    );
    await waitForSpawn(state);

    controller.abort();
    await vi.waitFor(() =>
      expect(state.signals).toEqual([{ pid: -4242, signal: "SIGTERM" }]),
    );
    state.child.emit("close", null, "SIGTERM");
    await expect(pending).resolves.toMatchObject({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });
  });

  it("does not spawn when durable request persistence fails", async () => {
    const state = harness();
    state.fs.failWrite = true;

    await expect(
      state.launcher.startUpdate(checkedReleaseFixture()),
    ).resolves.toEqual({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.fs.calls).toContain("unlink");
  });
});
