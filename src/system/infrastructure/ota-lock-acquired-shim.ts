import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { closeSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { parseLibcVersion } from "../domain/libc-version";
import { parseOtaOperationId } from "../domain/ota-contracts";

export const OTA_LOCK_ACQUIRED_MARKER = "HOME_WORKER_OTA_LOCK_ACQUIRED_V1\n";
const PROVENANCE_FD = 4;
const HANDSHAKE_FD = 3;
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
  on(event: string, listener: (...args: never[]) => void): this;
}

export type OtaLockAcquiredShimSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => OtaLockAcquiredShimChild;

export interface OtaLockAcquiredShimDependencies {
  writeAll(fd: number, bytes: Buffer): void;
  close(fd: number): void;
  spawn: OtaLockAcquiredShimSpawn;
  nodeExecutable: string;
  updaterEntry: string;
  sourceEnvironment: NodeJS.ProcessEnv;
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
  writeAll: defaultWriteAll,
  close: closeSync,
  spawn: (file, args, options) => nodeSpawn(file, [...args], options),
  nodeExecutable: process.execPath,
  updaterEntry: resolve(__dirname, "ota-updater.js"),
  sourceEnvironment: process.env,
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
  try {
    dependencies.writeAll(
      PROVENANCE_FD,
      Buffer.from(OTA_LOCK_ACQUIRED_MARKER, "ascii"),
    );
    dependencies.close(PROVENANCE_FD);
  } catch {
    try {
      dependencies.close(PROVENANCE_FD);
    } catch {
      // The marker could not be authenticated; never launch the updater.
    }
    return MAINTENANCE_EXIT_CODE;
  }

  let operationId: string;
  let environment: Readonly<Record<string, string>>;
  try {
    operationId = parseArguments(args);
    environment = updaterEnvironment(dependencies.sourceEnvironment);
  } catch {
    return MAINTENANCE_EXIT_CODE;
  }

  let child: OtaLockAcquiredShimChild;
  try {
    child = dependencies.spawn(
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
        stdio: ["ignore", "ignore", "ignore", HANDSHAKE_FD],
        env: environment,
      },
    );
    dependencies.close(HANDSHAKE_FD);
  } catch {
    try {
      dependencies.close(HANDSHAKE_FD);
    } catch {
      // Best effort: this process exits maintenance immediately.
    }
    return MAINTENANCE_EXIT_CODE;
  }

  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolveResult(code);
    };
    child.on("error", () => finish(MAINTENANCE_EXIT_CODE));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal !== null || code === null || !Number.isInteger(code)) {
        finish(MAINTENANCE_EXIT_CODE);
      } else if (code === 73) {
        finish(REMAPPED_CONTENTION_EXIT_CODE);
      } else if (code < 0 || code > 255) {
        finish(MAINTENANCE_EXIT_CODE);
      } else {
        finish(code);
      }
    });
  });
}

if (require.main === module) {
  void runOtaLockAcquiredShim(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
