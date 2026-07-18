import { Injectable } from "@nestjs/common";
import { randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat as nodeLstat,
  open as nodeOpen,
  realpath as nodeRealpath,
  rename as nodeRename,
  unlink as nodeUnlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  createOtaOperationRequest,
  parseCheckedReleaseIdentity,
  parseOtaOperationId,
  parseOtaOperationReceipt,
  type CheckedReleaseIdentity,
  type OtaOperationReceipt,
  type OtaOperationRequest,
  type StartOperationResult,
} from "../domain/ota-contracts";
import { compareLibcVersions, parseLibcVersion } from "../domain/libc-version";
import type { OtaOperationLauncherPort } from "../domain/ports/ota-operation-launcher.port";
import type {
  OtaConfig,
  OtaLauncherConfig,
} from "./ota-discovery-config.loader";
import {
  OTA_LOCK_ACQUIRED_MARKER,
  OTA_LOCK_CONFLICT_MARKER,
} from "./ota-lock-acquired-shim";

export {
  OTA_LOCK_ACQUIRED_MARKER,
  OTA_LOCK_CONFLICT_MARKER,
} from "./ota-lock-acquired-shim";

const MAX_RECEIPT_BYTES = 1024;
const MAX_MARKER_BYTES = 128;

export interface OtaLauncherFileHandle {
  readonly fd: number;
  writeFile(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface OtaLauncherFileSystem {
  open(
    path: string,
    flags: number,
    mode?: number,
  ): Promise<OtaLauncherFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  lstat(path: string): Promise<OtaLauncherStats>;
  realpath(path: string): Promise<string>;
  currentUid(): number;
}

export interface OtaLauncherStats {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly uid: number;
  readonly mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface OtaLauncherChild {
  readonly pid?: number;
  readonly stdio: readonly [
    unknown,
    unknown,
    unknown,
    Readable | null,
    Readable | null,
    unknown,
  ];
  on(event: string, listener: (...args: never[]) => void): this;
  unref(): void;
}

export interface OtaLauncherTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type OtaLauncherSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => OtaLauncherChild;

export interface OtaLauncherDependencies {
  fs: OtaLauncherFileSystem;
  spawn: OtaLauncherSpawn;
  randomBytes(size: number): Buffer;
  now(): Date;
  timer: OtaLauncherTimer;
  signalProcessGroup(pid: number, signal: NodeJS.Signals): void;
}

const nodeFileSystem: OtaLauncherFileSystem = {
  open: (path, flags, mode) => nodeOpen(path, flags, mode),
  rename: nodeRename,
  unlink: nodeUnlink,
  lstat: nodeLstat,
  realpath: nodeRealpath,
  currentUid: () => {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("current uid is unavailable");
    return uid;
  },
};

const nodeTimer: OtaLauncherTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const defaultDependencies: OtaLauncherDependencies = {
  fs: nodeFileSystem,
  spawn: (file, args, options) =>
    nodeSpawn(file, [...args], options) as unknown as OtaLauncherChild,
  randomBytes: nodeRandomBytes,
  now: () => new Date(),
  timer: nodeTimer,
  signalProcessGroup: (pid, signal) => process.kill(pid, signal),
};

function rejected(
  code: "operation-in-progress" | "maintenance-required",
): StartOperationResult {
  return { kind: "rejected", failure: { code } };
}

function sameString(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function sameReceipt(
  receipt: OtaOperationReceipt,
  request: OtaOperationRequest,
): boolean {
  return (
    receipt.schemaVersion === request.schemaVersion &&
    sameString(receipt.operationId, request.operationId) &&
    receipt.kind === request.kind &&
    sameString(receipt.acceptedAt, request.acceptedAt) &&
    sameString(receipt.requestSha256, request.requestSha256)
  );
}

function validateExpectedIdentity(
  input: CheckedReleaseIdentity,
  config: OtaLauncherConfig,
): CheckedReleaseIdentity {
  const expected = parseCheckedReleaseIdentity(input);
  const artifact = expected.artifact;
  const policy = config.policy;
  const runtimeLibcVersion = parseLibcVersion(policy.target.libcVersion);
  if (
    expected.metadata.channel !== policy.channel ||
    artifact.targetName !== policy.target.targetName ||
    artifact.target.platform !== policy.target.platform ||
    artifact.target.arch !== policy.target.arch ||
    artifact.target.libc !== policy.target.libc ||
    artifact.target.nodeModulesAbi !== policy.target.nodeModulesAbi ||
    compareLibcVersions(artifact.target.libcMinVersion, runtimeLibcVersion) >
      0 ||
    !/^[0-9a-f]{40}$/.test(artifact.commit) ||
    artifact.size > policy.limits.maxArtifactBytes ||
    artifact.expandedSize > policy.limits.maxExpandedBytes ||
    artifact.maxPreparedSize > policy.limits.maxPreparedBytes ||
    artifact.maxPreparedFiles > policy.limits.maxPreparedFiles ||
    artifact.fileCount > policy.limits.maxFiles ||
    artifact.expandedSize > artifact.maxPreparedSize ||
    artifact.fileCount > artifact.maxPreparedFiles ||
    Date.parse(expected.metadata.publishedAt) >=
      Date.parse(expected.metadata.expiresAt)
  ) {
    throw new Error("checked release identity is outside the OTA policy");
  }

  const feedUrl = new URL(policy.feedUrl);
  const artifactUrl = new URL(artifact.url);
  if (
    artifact.url.length > 2048 ||
    feedUrl.protocol !== "https:" ||
    artifactUrl.protocol !== "https:" ||
    artifactUrl.origin !== feedUrl.origin ||
    artifactUrl.username !== "" ||
    artifactUrl.password !== "" ||
    artifactUrl.hash !== ""
  ) {
    throw new Error("checked release artifact origin is invalid");
  }
  return expected;
}

export function operationRequestPath(
  config: Pick<OtaLauncherConfig, "requestDirectory">,
  operationId: string,
): string {
  return join(
    config.requestDirectory,
    `${parseOtaOperationId(operationId)}.json`,
  );
}

@Injectable()
export class FlockOtaOperationLauncherAdapter implements OtaOperationLauncherPort {
  constructor(
    private readonly config: OtaConfig,
    private readonly dependencies: OtaLauncherDependencies = defaultDependencies,
  ) {}

  startUpdate(
    expected: CheckedReleaseIdentity,
    signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    return this.launch("update", expected, signal);
  }

  startRollback(signal?: AbortSignal): Promise<StartOperationResult> {
    return this.launch("rollback", null, signal);
  }

  private async launch(
    kind: "update" | "rollback",
    expectedInput: CheckedReleaseIdentity | null,
    signal?: AbortSignal,
  ): Promise<StartOperationResult> {
    if (signal?.aborted) return rejected("maintenance-required");

    let request: OtaOperationRequest;
    let requestBytes: Buffer;
    let requestPath: string;
    try {
      await this.preflightUpdater();
      const operationBytes = this.dependencies.randomBytes(16);
      if (operationBytes.byteLength !== 16) {
        throw new Error("operation ID entropy source returned the wrong size");
      }
      const operationId = operationBytes.toString("base64url");
      const expected =
        expectedInput === null
          ? null
          : validateExpectedIdentity(expectedInput, this.config.launcher);
      const created = createOtaOperationRequest({
        operationId,
        kind,
        expected,
        acceptedAt: this.dependencies.now().toISOString(),
      });
      request = created.request;
      requestBytes = created.bytes;
      requestPath = operationRequestPath(this.config.launcher, operationId);
      await this.persistRequest(requestPath, operationId, requestBytes);
    } catch {
      return rejected("maintenance-required");
    }

    if (signal?.aborted) {
      await this.removeRequest(requestPath);
      return rejected("maintenance-required");
    }

    let lockLease: OtaLauncherFileHandle | undefined;
    try {
      lockLease = await this.dependencies.fs.open(
        this.config.launcher.lockPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      if (!Number.isSafeInteger(lockLease.fd) || lockLease.fd < 0) {
        throw new Error("lock lease returned an unsafe file descriptor");
      }
    } catch {
      await lockLease?.close().catch(() => undefined);
      await this.removeRequest(requestPath);
      return rejected("maintenance-required");
    }

    if (lockLease === undefined) {
      await this.removeRequest(requestPath);
      return rejected("maintenance-required");
    }

    if (signal?.aborted) {
      await lockLease.close().catch(() => undefined);
      await this.removeRequest(requestPath);
      return rejected("maintenance-required");
    }

    let child: OtaLauncherChild;
    try {
      child = this.dependencies.spawn(
        this.config.launcher.nodeExecutable,
        [
          this.config.launcher.lockAcquiredShimEntry,
          "--operation-id",
          request.operationId,
          "--handshake-fd",
          "3",
        ],
        {
          detached: true,
          shell: false,
          stdio: ["ignore", "ignore", "ignore", "pipe", "pipe", lockLease.fd],
          env: this.config.launcher.environment,
        },
      );
    } catch {
      await lockLease.close().catch(() => undefined);
      await this.removeRequest(requestPath);
      return rejected("maintenance-required");
    }

    const forcedCleanup = new AbortController();
    const resultPromise = this.waitForReceipt(
      child,
      request,
      signal,
      forcedCleanup.signal,
    );
    try {
      await lockLease.close();
    } catch {
      forcedCleanup.abort();
      await resultPromise;
      await lockLease.close().catch(() => undefined);
      await this.removeRequest(requestPath);
      return rejected("maintenance-required");
    }

    const result = await resultPromise;
    if (result.kind === "rejected") {
      const cleaned = await this.removeRequest(requestPath);
      if (!cleaned) return rejected("maintenance-required");
    }
    return result;
  }

  private async preflightUpdater(): Promise<void> {
    const updaterPath = this.config.launcher.updaterEntry;
    const uid = this.dependencies.fs.currentUid();
    const pathStat = await this.dependencies.fs.lstat(updaterPath);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.uid !== uid ||
      (pathStat.mode & 0o022) !== 0
    ) {
      throw new Error("updater entry failed provenance validation");
    }

    const resolvedPath = await this.dependencies.fs.realpath(updaterPath);
    const resolvedParent = await this.dependencies.fs.realpath(
      dirname(updaterPath),
    );
    if (resolvedPath !== join(resolvedParent, basename(updaterPath))) {
      throw new Error("updater entry escaped its fixed directory");
    }
    const resolvedStat = await this.dependencies.fs.lstat(resolvedPath);
    if (
      resolvedStat.isSymbolicLink() ||
      !resolvedStat.isFile() ||
      resolvedStat.uid !== uid ||
      (resolvedStat.mode & 0o022) !== 0 ||
      resolvedStat.dev !== pathStat.dev ||
      resolvedStat.ino !== pathStat.ino
    ) {
      throw new Error("updater entry changed during provenance validation");
    }
  }

  private async persistRequest(
    requestPath: string,
    operationId: string,
    bytes: Buffer,
  ): Promise<void> {
    const suffix = this.dependencies.randomBytes(8);
    if (suffix.byteLength !== 8) {
      throw new Error("temporary-file entropy source returned the wrong size");
    }
    const temporaryPath = join(
      this.config.launcher.requestDirectory,
      `.${operationId}.${suffix.toString("hex")}.tmp`,
    );
    let handle: OtaLauncherFileHandle | undefined;
    let renamed = false;
    try {
      handle = await this.dependencies.fs.open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.dependencies.fs.rename(temporaryPath, requestPath);
      renamed = true;
      await this.syncRequestDirectory();
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      if (renamed) {
        await this.dependencies.fs.unlink(requestPath).catch(() => undefined);
        await this.syncRequestDirectory().catch(() => undefined);
      } else {
        await this.dependencies.fs.unlink(temporaryPath).catch(() => undefined);
      }
      throw error;
    }
  }

  private async syncRequestDirectory(): Promise<void> {
    const directory = await this.dependencies.fs.open(
      this.config.launcher.requestDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async removeRequest(path: string): Promise<boolean> {
    try {
      await this.dependencies.fs.unlink(path);
      await this.syncRequestDirectory();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
  }

  private waitForReceipt(
    child: OtaLauncherChild,
    request: OtaOperationRequest,
    signal?: AbortSignal,
    forcedCleanupSignal?: AbortSignal,
  ): Promise<StartOperationResult> {
    return new Promise((resolve) => {
      const pid = child.pid;
      const receiptPipe = child.stdio[3];
      const markerPipe = child.stdio[4];
      if (
        pid === undefined ||
        !Number.isSafeInteger(pid) ||
        pid <= 1 ||
        receiptPipe === null ||
        markerPipe === null
      ) {
        resolve(rejected("maintenance-required"));
        return;
      }

      let settled = false;
      let acceptingFrames = true;
      let receiptEnded = false;
      let receiptSawNewline = false;
      let receiptBytes = 0;
      const receiptChunks: Buffer[] = [];
      let validReceipt: OtaOperationReceipt | undefined;
      let markerEnded = false;
      let markerSawNewline = false;
      let markerBytes = 0;
      const markerChunks: Buffer[] = [];
      let markerState: "pending" | "absent" | "acquired" | "conflict" =
        "pending";
      let childClosed = false;
      let receiptWasValidAtClose = false;
      let graceTimer: unknown;
      let killWaitTimer: unknown;

      const clearTimers = (): void => {
        this.dependencies.timer.clearTimeout(handshakeTimer);
        if (graceTimer !== undefined) {
          this.dependencies.timer.clearTimeout(graceTimer);
        }
        if (killWaitTimer !== undefined) {
          this.dependencies.timer.clearTimeout(killWaitTimer);
        }
        signal?.removeEventListener("abort", onAbort);
        forcedCleanupSignal?.removeEventListener("abort", onAbort);
      };

      const finish = (result: StartOperationResult): void => {
        if (settled) return;
        settled = true;
        acceptingFrames = false;
        clearTimers();
        if (result.kind === "started") child.unref();
        resolve(result);
      };

      const signalGroup = (groupSignal: NodeJS.Signals): void => {
        try {
          this.dependencies.signalProcessGroup(-pid, groupSignal);
        } catch {
          // A concurrently reaped group is still handled by child close or the
          // bounded kill-wait timer. No raw process diagnostic escapes.
        }
      };

      const beginTermination = (): void => {
        if (settled || !acceptingFrames) return;
        acceptingFrames = false;
        this.dependencies.timer.clearTimeout(handshakeTimer);
        signalGroup("SIGTERM");
        if (settled) return;
        graceTimer = this.dependencies.timer.setTimeout(() => {
          if (settled) return;
          signalGroup("SIGKILL");
          if (settled) return;
          killWaitTimer = this.dependencies.timer.setTimeout(() => {
            if (!settled) signalGroup("SIGKILL");
          }, this.config.launcher.killWaitMs);
        }, this.config.launcher.terminateGraceMs);
      };

      const onAbort = (): void => beginTermination();
      signal?.addEventListener("abort", onAbort, { once: true });
      forcedCleanupSignal?.addEventListener("abort", onAbort, { once: true });

      const handshakeTimer = this.dependencies.timer.setTimeout(
        beginTermination,
        this.config.launcher.handshakeTimeoutMs,
      );

      const maybeFinishStarted = (): void => {
        if (markerState === "acquired" && validReceipt !== undefined) {
          if (!childClosed || receiptWasValidAtClose) {
            finish({ kind: "started", receipt: validReceipt });
          } else {
            finish(rejected("maintenance-required"));
          }
        } else if (markerState === "absent" && validReceipt !== undefined) {
          beginTermination();
        }
      };

      const maybeFinishClosed = (): void => {
        if (!childClosed || settled) return;
        if (!acceptingFrames) {
          finish(rejected("maintenance-required"));
          return;
        }
        if (!receiptEnded || !markerEnded) return;
        if (
          markerState === "conflict" &&
          receiptBytes === 0 &&
          validReceipt === undefined
        ) {
          finish(rejected("operation-in-progress"));
          return;
        }
        finish(rejected("maintenance-required"));
      };

      receiptPipe.on("data", (chunk: Buffer | string) => {
        if (!acceptingFrames || settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (
          receiptSawNewline ||
          receiptBytes + bytes.byteLength > MAX_RECEIPT_BYTES
        ) {
          beginTermination();
          return;
        }
        const newline = bytes.indexOf(0x0a);
        if (newline !== -1) {
          if (
            newline !== bytes.byteLength - 1 ||
            bytes.indexOf(0x0a, newline + 1) !== -1
          ) {
            beginTermination();
            return;
          }
          receiptSawNewline = true;
        }
        receiptBytes += bytes.byteLength;
        receiptChunks.push(bytes);
      });

      receiptPipe.on("end", () => {
        receiptEnded = true;
        if (!acceptingFrames || settled) return;
        if (!receiptSawNewline) {
          if (receiptBytes > 0) beginTermination();
          else maybeFinishClosed();
          return;
        }
        try {
          const frame = Buffer.concat(receiptChunks, receiptBytes);
          if (frame[frame.byteLength - 1] !== 0x0a) {
            throw new Error("receipt is not newline terminated");
          }
          const receipt = parseOtaOperationReceipt(
            frame.subarray(0, frame.byteLength - 1),
          );
          if (!sameReceipt(receipt, request)) {
            throw new Error("receipt does not bind the operation request");
          }
          validReceipt = receipt;
          maybeFinishStarted();
          maybeFinishClosed();
        } catch {
          beginTermination();
        }
      });

      receiptPipe.on("error", () => beginTermination());
      receiptPipe.on("close", () => {
        if (!receiptEnded && !settled) beginTermination();
      });

      markerPipe.on("data", (chunk: Buffer | string) => {
        if (!acceptingFrames || settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (
          markerSawNewline ||
          markerBytes + bytes.byteLength > MAX_MARKER_BYTES
        ) {
          beginTermination();
          return;
        }
        const newline = bytes.indexOf(0x0a);
        if (newline !== -1) {
          if (
            newline !== bytes.byteLength - 1 ||
            bytes.indexOf(0x0a, newline + 1) !== -1
          ) {
            beginTermination();
            return;
          }
          markerSawNewline = true;
        }
        markerBytes += bytes.byteLength;
        markerChunks.push(bytes);
      });

      markerPipe.on("end", () => {
        markerEnded = true;
        if (!acceptingFrames || settled) return;
        if (markerBytes === 0) {
          markerState = "absent";
          maybeFinishStarted();
          maybeFinishClosed();
          return;
        }
        try {
          const frame = Buffer.concat(markerChunks, markerBytes);
          const acquired = Buffer.from(OTA_LOCK_ACQUIRED_MARKER, "ascii");
          const conflict = Buffer.from(OTA_LOCK_CONFLICT_MARKER, "ascii");
          const isAcquired =
            frame.byteLength === acquired.byteLength &&
            timingSafeEqual(frame, acquired);
          const isConflict =
            frame.byteLength === conflict.byteLength &&
            timingSafeEqual(frame, conflict);
          if (!markerSawNewline || (!isAcquired && !isConflict)) {
            throw new Error("invalid lock-acquired marker");
          }
          markerState = isAcquired ? "acquired" : "conflict";
          maybeFinishStarted();
          maybeFinishClosed();
        } catch {
          beginTermination();
        }
      });

      markerPipe.on("error", () => beginTermination());
      markerPipe.on("close", () => {
        if (!markerEnded && !settled) beginTermination();
      });

      child.on("error", () => beginTermination());
      child.on("close", () => {
        if (settled) return;
        childClosed = true;
        receiptWasValidAtClose = validReceipt !== undefined;
        if (markerState === "acquired" && !receiptWasValidAtClose) {
          finish(rejected("maintenance-required"));
          return;
        }
        maybeFinishClosed();
      });

      if (signal?.aborted || forcedCleanupSignal?.aborted) beginTermination();
    });
  }
}
