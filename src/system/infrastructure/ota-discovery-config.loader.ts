import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { UpdateCheckOptions } from "../application/ports/update-check-options.port";
import type { UpdateDiscoveryOptions } from "../application/ports/update-discovery-options.port";
import {
  updateTargetName,
  type UpdateTargetName,
} from "../domain/ota-contracts";
import type { ManifestPolicy } from "../domain/signed-manifest";

export type OtaDiscoveryMode = "real" | "stub";

export interface OtaDiscoveryConfigInput {
  mode: OtaDiscoveryMode;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  nodeModulesAbi: string;
}

export interface OtaDiscoveryConfig {
  feedUrl: string;
  trustDirectory: string;
  policy: ManifestPolicy;
  checkOptions: UpdateCheckOptions;
  discoveryOptions: UpdateDiscoveryOptions;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.length === 0)
    throw new Error(`${key} is required`);
  return value;
}

function runtimeTarget(input: OtaDiscoveryConfigInput): {
  targetName: UpdateTargetName;
  arch: "arm" | "arm64";
} {
  if (input.platform !== "linux")
    throw new Error("unsupported OTA runtime platform");
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

export function loadOtaDiscoveryConfig(
  input: OtaDiscoveryConfigInput,
): OtaDiscoveryConfig {
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
      maxArtifactBytes: boundedInteger(
        input.env.HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES,
        100 * 1024 * 1024,
        1,
        100 * 1024 * 1024,
        "HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES",
      ),
      maxExpandedBytes: boundedInteger(
        input.env.HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES,
        512 * 1024 * 1024,
        1,
        512 * 1024 * 1024,
        "HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES",
      ),
      maxPreparedBytes: 1024 * 1024 * 1024,
      maxPreparedFiles: 200_000,
      maxFiles: boundedInteger(
        input.env.HOME_WORKER_UPDATE_MAX_FILES,
        20_000,
        1,
        20_000,
        "HOME_WORKER_UPDATE_MAX_FILES",
      ),
    },
  };

  return {
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
      pollIntervalMs:
        boundedInteger(
          input.env.HOME_WORKER_UPDATE_POLL_MINUTES,
          60,
          1,
          24 * 60,
          "HOME_WORKER_UPDATE_POLL_MINUTES",
        ) *
        60 *
        1000,
      startupJitterMaxMs: 300_000,
    },
  };
}
