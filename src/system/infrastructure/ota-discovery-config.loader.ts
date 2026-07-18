import { accessSync, constants, lstatSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { UpdateCheckOptions } from "../application/ports/update-check-options.port";
import type { UpdateDiscoveryOptions } from "../application/ports/update-discovery-options.port";
import {
  updateTargetName,
  type UpdateTargetName,
} from "../domain/ota-contracts";
import type { ManifestPolicy } from "../domain/signed-manifest";

export type OtaDiscoveryMode = "real" | "stub";

export const OTA_FIXED_PATHS = Object.freeze({
  flockPath: "/usr/bin/flock",
  lockPath: "/run/home-worker/ota.lock",
  requestDirectory: "/run/home-worker/requests",
});

export interface OtaFixedPaths {
  flockPath: string;
  nodeExecutable: string;
  lockPath: string;
  requestDirectory: string;
  updaterEntry: string;
}

export interface OtaDiscoveryConfigInput {
  mode: OtaDiscoveryMode;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  nodeModulesAbi: string;
  nodeExecutable?: string;
  validateFixedPaths?: (paths: OtaFixedPaths) => void;
}

export interface OtaUpdaterConfig {
  healthSeconds: number;
}

export interface OtaLauncherConfig extends OtaFixedPaths {
  conflictExitCode: number;
  handshakeTimeoutMs: number;
  terminateGraceMs: number;
  killWaitMs: number;
  policy: ManifestPolicy;
  environment: Readonly<Record<string, string>>;
}

export interface OtaConfig {
  mode: OtaDiscoveryMode;
  feedUrl: string;
  trustDirectory: string;
  policy: ManifestPolicy;
  checkOptions: UpdateCheckOptions;
  discoveryOptions: UpdateDiscoveryOptions;
  updater: OtaUpdaterConfig;
  launcher: OtaLauncherConfig;
}

export type OtaDiscoveryConfig = OtaConfig;

function boundedPositiveDecimal(
  value: string | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function runtimeTarget(input: OtaDiscoveryConfigInput): {
  targetName: UpdateTargetName;
  arch: "arm" | "arm64";
} {
  if (input.platform !== "linux") {
    throw new Error("unsupported OTA runtime platform");
  }
  if (input.architecture !== "arm" && input.architecture !== "arm64") {
    throw new Error("unsupported OTA runtime architecture");
  }
  const arch = input.architecture;
  return {
    arch,
    targetName: updateTargetName({ platform: "linux", arch, libc: "glibc" }),
  };
}

function validateTrustDirectory(directory: string): void {
  if (!isAbsolute(directory)) {
    throw new Error("HOME_WORKER_UPDATE_TRUST_DIR must be an absolute path");
  }
  try {
    const base = lstatSync(directory);
    const active = lstatSync(join(directory, "active"));
    if (!base.isDirectory() || base.isSymbolicLink()) {
      throw new Error("invalid base");
    }
    if (!active.isDirectory() || active.isSymbolicLink()) {
      throw new Error("invalid active");
    }
  } catch {
    throw new Error(
      "HOME_WORKER_UPDATE_TRUST_DIR must be a real directory containing active/",
    );
  }
}

function validateFeedUrl(value: string, targetName: UpdateTargetName): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HOME_WORKER_UPDATE_FEED_URL is invalid");
  }
  const expectedPath = `/home-worker/stable/${targetName}/update-envelope.json`;
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== expectedPath
  ) {
    throw new Error("HOME_WORKER_UPDATE_FEED_URL is invalid");
  }
  return url.href;
}

function realPath(path: string, label: string): Stats {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  return stat;
}

function defaultValidateFixedPaths(paths: OtaFixedPaths): void {
  try {
    for (const [path, label] of [
      [paths.flockPath, "flock path"],
      [paths.nodeExecutable, "Node executable"],
    ] as const) {
      const stat = realPath(path, label);
      if (!stat.isFile() || (stat.mode & 0o022) !== 0) {
        throw new Error(`${label} must be a regular file`);
      }
      accessSync(path, constants.X_OK);
    }
    const updaterEntry = realPath(paths.updaterEntry, "updater entry");
    if (!updaterEntry.isFile() || (updaterEntry.mode & 0o022) !== 0) {
      throw new Error("updater entry must be a regular file");
    }
    accessSync(paths.updaterEntry, constants.R_OK);

    const lockParent = realPath(dirname(paths.lockPath), "lock parent");
    if (!lockParent.isDirectory() || (lockParent.mode & 0o022) !== 0) {
      throw new Error("lock parent must be a protected directory");
    }
    accessSync(dirname(paths.lockPath), constants.W_OK | constants.X_OK);
    try {
      const lock = realPath(paths.lockPath, "lock path");
      if (!lock.isFile()) throw new Error("lock path must be a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const requestDirectory = realPath(
      paths.requestDirectory,
      "request directory",
    );
    const currentUid = process.getuid?.();
    if (
      !requestDirectory.isDirectory() ||
      (requestDirectory.mode & 0o777) !== 0o700 ||
      (currentUid !== undefined && requestDirectory.uid !== currentUid)
    ) {
      throw new Error("request directory must be worker-owned mode 0700");
    }
    accessSync(paths.requestDirectory, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error("compiled OTA launcher paths are invalid");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function loadOtaConfig(input: OtaDiscoveryConfigInput): OtaConfig {
  const target =
    input.mode === "real"
      ? runtimeTarget(input)
      : { targetName: "linux-arm64-glibc" as const, arch: "arm64" as const };

  let feedUrl: string;
  let trustDirectory: string;
  if (input.mode === "real") {
    const channel = required(input.env, "HOME_WORKER_UPDATE_CHANNEL");
    if (channel !== "stable") {
      throw new Error("HOME_WORKER_UPDATE_CHANNEL must be stable");
    }
    const configuredTarget = required(input.env, "HOME_WORKER_UPDATE_TARGET");
    if (configuredTarget !== target.targetName) {
      throw new Error(
        "HOME_WORKER_UPDATE_TARGET is incompatible with this runtime",
      );
    }
    feedUrl = validateFeedUrl(
      required(input.env, "HOME_WORKER_UPDATE_FEED_URL"),
      target.targetName,
    );
    trustDirectory = required(input.env, "HOME_WORKER_UPDATE_TRUST_DIR");
    validateTrustDirectory(trustDirectory);
  } else {
    feedUrl =
      "https://updates.invalid/home-worker/stable/linux-arm64-glibc/update-envelope.json";
    trustDirectory = "/nonexistent/home-worker-update-keys";
  }

  const maxArtifactBytes = boundedPositiveDecimal(
    input.env.HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES,
    100 * 1024 * 1024,
    100 * 1024 * 1024,
    "HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES",
  );
  const maxExpandedBytes = boundedPositiveDecimal(
    input.env.HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES,
    512 * 1024 * 1024,
    512 * 1024 * 1024,
    "HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES",
  );
  const maxFiles = boundedPositiveDecimal(
    input.env.HOME_WORKER_UPDATE_MAX_FILES,
    20_000,
    20_000,
    "HOME_WORKER_UPDATE_MAX_FILES",
  );
  const pollMinutes = boundedPositiveDecimal(
    input.env.HOME_WORKER_UPDATE_POLL_MINUTES,
    60,
    24 * 60,
    "HOME_WORKER_UPDATE_POLL_MINUTES",
  );
  const healthSeconds = boundedPositiveDecimal(
    input.env.HOME_WORKER_UPDATE_HEALTH_SECONDS,
    60,
    300,
    "HOME_WORKER_UPDATE_HEALTH_SECONDS",
  );

  const policy: ManifestPolicy = {
    feedUrl,
    channel: "stable",
    target: {
      targetName: target.targetName,
      platform: "linux",
      arch: target.arch,
      libc: "glibc",
      libcVersion: input.env.HOME_WORKER_GLIBC_VERSION ?? "2.28",
      nodeModulesAbi: input.nodeModulesAbi,
    },
    runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
    limits: {
      maxArtifactBytes,
      maxExpandedBytes,
      maxPreparedBytes: 1024 * 1024 * 1024,
      maxPreparedFiles: 200_000,
      maxFiles,
    },
  };

  const fixedPaths: OtaFixedPaths = {
    ...OTA_FIXED_PATHS,
    nodeExecutable: input.nodeExecutable ?? process.execPath,
    updaterEntry: resolve(__dirname, "ota-updater.js"),
  };
  if (input.mode === "real") {
    (input.validateFixedPaths ?? defaultValidateFixedPaths)(fixedPaths);
  }

  const updaterEnvironment = {
    PATH: "/usr/bin:/bin",
    NODE_ENV: "production",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    HOME_WORKER_UPDATE_FEED_URL: feedUrl,
    HOME_WORKER_UPDATE_TRUST_DIR: trustDirectory,
    HOME_WORKER_UPDATE_CHANNEL: "stable",
    HOME_WORKER_UPDATE_TARGET: target.targetName,
    HOME_WORKER_UPDATE_LOCK_PATH: fixedPaths.lockPath,
    HOME_WORKER_UPDATE_REQUEST_DIR: fixedPaths.requestDirectory,
    HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES: String(maxArtifactBytes),
    HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES: String(maxExpandedBytes),
    HOME_WORKER_UPDATE_MAX_FILES: String(maxFiles),
    HOME_WORKER_UPDATE_HEALTH_SECONDS: String(healthSeconds),
  };

  return deepFreeze({
    mode: input.mode,
    feedUrl,
    trustDirectory,
    policy,
    checkOptions: {
      feedUrl,
      maxEnvelopeBytes: 96 * 1024,
      timeouts: {
        connectMs: 10_000,
        firstByteMs: 10_000,
        idleMs: 15_000,
        totalMs: 60_000,
      },
    },
    discoveryOptions: {
      pollIntervalMs: pollMinutes * 60 * 1000,
      startupJitterMaxMs: 300_000,
    },
    updater: { healthSeconds },
    launcher: {
      ...fixedPaths,
      conflictExitCode: 73,
      handshakeTimeoutMs: 10_000,
      terminateGraceMs: 2_000,
      killWaitMs: 2_000,
      policy,
      environment: updaterEnvironment,
    },
  });
}

export const loadOtaDiscoveryConfig = loadOtaConfig;
