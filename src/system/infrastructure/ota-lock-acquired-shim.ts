import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { closeSync, fstatSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { parseLibcVersion } from "../domain/libc-version";
import { parseOtaOperationId } from "../domain/ota-contracts";

export const OTA_LOCK_ACQUIRED_MARKER = "lock-acquired\n";
export const OTA_LOCK_CONFLICT_MARKER = "lock-conflict\n";
const PROVENANCE_FD = 4;
const HANDSHAKE_FD = 3;
const LOCK_LEASE_FD = 5;
const MAINTENANCE_EXIT_CODE = 75;
const REMAPPED_CONTENTION_EXIT_CODE = 74;

const UPDATER_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "TZ",
  "HOME_WORKER_UPDATE_FEED_URL",
  "HOME_WORKER_UPDATE_TRUST_DIR",
  "HOME_WORKER_UPDATE_CHANNEL",
  "HOME_WORKER_UPDATE_TARGET",
  "HOME_WORKER_UPDATE_LOCK_PATH",
  "HOME_WORKER_UPDATE_REQUEST_DIR",
  "HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES",
  "HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES",
  "HOME_WORKER_UPDATE_MAX_FILES",
  "HOME_WORKER_UPDATE_HEALTH_SECONDS",
  "HOME_WORKER_UPDATE_RUNTIME_LIBC_VERSION",
] as const);

export interface OtaLockAcquiredShimChild {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on(event: string, listener: (...args: never[]) => void): this;
  kill(signal: NodeJS.Signals): boolean;
}

export type OtaLockAcquiredShimSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => OtaLockAcquiredShimChild;

export interface OtaLockAcquiredShimDependencies {
  assertLockLease(fd: number): void;
  writeAll(fd: number, bytes: Buffer): void;
  close(fd: number): void;
  spawn: OtaLockAcquiredShimSpawn;
  flockPath: string;
  nodeExecutable: string;
  updaterEntry: string;
  sourceEnvironment: NodeJS.ProcessEnv;
  onSignal(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
  removeSignal(signal: "SIGTERM" | "SIGINT", listener: () => void): void;
}

function defaultWriteAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("failed to write lock marker");
    offset += written;
  }
}

const defaultDependencies: OtaLockAcquiredShimDependencies = {
  assertLockLease: (fd) => {
    if (!fstatSync(fd).isFile()) {
      throw new Error("lock lease must be a regular file");
    }
  },
  writeAll: defaultWriteAll,
  close: closeSync,
  spawn: (file, args, options) => nodeSpawn(file, [...args], options),
  flockPath: "/usr/bin/flock",
  nodeExecutable: process.execPath,
  updaterEntry: resolve(__dirname, "ota-updater.entry.js"),
  sourceEnvironment: process.env,
  onSignal: (signal, listener) => process.on(signal, listener),
  removeSignal: (signal, listener) => process.off(signal, listener),
};

function updaterEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const key of UPDATER_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value === undefined || value.length === 0) {
      throw new Error(`missing updater environment key: ${key}`);
    }
    selected[key] = value;
  }
  selected.HOME_WORKER_UPDATE_RUNTIME_LIBC_VERSION = parseLibcVersion(
    selected.HOME_WORKER_UPDATE_RUNTIME_LIBC_VERSION,
  );
  return Object.freeze(selected);
}

function parseArguments(args: readonly string[]): string {
  if (
    args.length !== 4 ||
    args[0] !== "--operation-id" ||
    args[2] !== "--handshake-fd" ||
    args[3] !== String(HANDSHAKE_FD)
  ) {
    throw new Error("invalid shim arguments");
  }
  return parseOtaOperationId(args[1]);
}

export async function runOtaLockAcquiredShim(
  args: readonly string[],
  dependencies: OtaLockAcquiredShimDependencies = defaultDependencies,
): Promise<number> {
  let stopping = false;
  let maintenance = false;
  let activeChild: OtaLockAcquiredShimChild | undefined;
  let controlClosed = false;
  let handshakeClosed = false;

  const beginStopping = (signal: "SIGTERM" | "SIGINT"): void => {
    stopping = true;
    const child = activeChild;
    if (child?.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        maintenance = true;
      }
    }
  };
  const onSigterm = (): void => beginStopping("SIGTERM");
  const onSigint = (): void => beginStopping("SIGINT");
  dependencies.onSignal("SIGTERM", onSigterm);
  dependencies.onSignal("SIGINT", onSigint);

  const closeControl = (): void => {
    if (controlClosed) return;
    dependencies.close(PROVENANCE_FD);
    controlClosed = true;
  };
  const closeHandshake = (): void => {
    if (handshakeClosed) return;
    dependencies.close(HANDSHAKE_FD);
    handshakeClosed = true;
  };
  const emitControl = (frame: string): boolean => {
    try {
      dependencies.writeAll(PROVENANCE_FD, Buffer.from(frame, "ascii"));
      closeControl();
      return true;
    } catch {
      try {
        closeControl();
      } catch {
        // Process exit closes the descriptor without authenticating a frame.
      }
      return false;
    }
  };
  const waitForClose = (
    child: OtaLockAcquiredShimChild,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
    new Promise((resolveResult) => {
      let closed = false;
      child.on("error", () => {
        maintenance = true;
        stopping = true;
      });
      child.on(
        "close",
        (code: number | null, signal: NodeJS.Signals | null) => {
          if (closed) return;
          closed = true;
          resolveResult({ code, signal });
        },
      );
    });

  try {
    if (stopping) return MAINTENANCE_EXIT_CODE;
    dependencies.assertLockLease(LOCK_LEASE_FD);
    const operationId = parseArguments(args);
    const environment = updaterEnvironment(dependencies.sourceEnvironment);
    if (stopping) return MAINTENANCE_EXIT_CODE;

    let helper: OtaLockAcquiredShimChild;
    try {
      helper = dependencies.spawn(
        dependencies.flockPath,
        [
          "--exclusive",
          "--nonblock",
          "--conflict-exit-code",
          "73",
          String(LOCK_LEASE_FD),
        ],
        {
          shell: false,
          stdio: [
            "ignore",
            "ignore",
            "ignore",
            "ignore",
            "ignore",
            LOCK_LEASE_FD,
          ],
          env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        },
      );
    } catch {
      return MAINTENANCE_EXIT_CODE;
    }
    activeChild = helper;
    const helperResult = await waitForClose(helper);
    activeChild = undefined;
    if (stopping || maintenance || helperResult.signal !== null) {
      return MAINTENANCE_EXIT_CODE;
    }
    if (helperResult.code === 73) {
      if (!emitControl(OTA_LOCK_CONFLICT_MARKER)) {
        return MAINTENANCE_EXIT_CODE;
      }
      try {
        closeHandshake();
      } catch {
        return MAINTENANCE_EXIT_CODE;
      }
      return 73;
    }
    if (helperResult.code !== 0) return MAINTENANCE_EXIT_CODE;
    if (!emitControl(OTA_LOCK_ACQUIRED_MARKER) || stopping) {
      return MAINTENANCE_EXIT_CODE;
    }

    let updater: OtaLockAcquiredShimChild;
    try {
      updater = dependencies.spawn(
        dependencies.nodeExecutable,
        [
          dependencies.updaterEntry,
          "--operation-id",
          operationId,
          "--handshake-fd",
          String(HANDSHAKE_FD),
        ],
        {
          shell: false,
          stdio: [
            "ignore",
            "ignore",
            "ignore",
            HANDSHAKE_FD,
            "ignore",
            LOCK_LEASE_FD,
          ],
          env: environment,
        },
      );
    } catch {
      return MAINTENANCE_EXIT_CODE;
    }
    activeChild = updater;
    const updaterResult = waitForClose(updater);
    try {
      closeHandshake();
    } catch {
      maintenance = true;
      beginStopping("SIGTERM");
    }
    const result = await updaterResult;
    activeChild = undefined;
    if (
      stopping ||
      maintenance ||
      result.signal !== null ||
      result.code === null ||
      !Number.isInteger(result.code) ||
      result.code < 0 ||
      result.code > 255
    ) {
      return MAINTENANCE_EXIT_CODE;
    }
    return result.code === 73 ? REMAPPED_CONTENTION_EXIT_CODE : result.code;
  } catch {
    return MAINTENANCE_EXIT_CODE;
  } finally {
    if (activeChild === undefined) {
      try {
        closeControl();
      } catch {
        // Process exit is now safe because no supervised child remains.
      }
      try {
        closeHandshake();
      } catch {
        // Process exit is now safe because no supervised child remains.
      }
      dependencies.removeSignal("SIGTERM", onSigterm);
      dependencies.removeSignal("SIGINT", onSigint);
    }
  }
}

if (require.main === module) {
  void runOtaLockAcquiredShim(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
