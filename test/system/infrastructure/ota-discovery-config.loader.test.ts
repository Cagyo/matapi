import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadOtaConfig,
  loadOtaDiscoveryConfig,
} from "../../../src/system/infrastructure/ota-discovery-config.loader";

const temporaryDirectories: string[] = [];

function trustDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "home-worker-ota-config-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "active"));
  return directory;
}

function validEnv(target = "linux-armv7-glibc"): NodeJS.ProcessEnv {
  return {
    HOME_WORKER_UPDATE_FEED_URL: `https://updates.example.test/home-worker/stable/${target}/update-envelope.json`,
    HOME_WORKER_UPDATE_TRUST_DIR: trustDirectory(),
    HOME_WORKER_UPDATE_CHANNEL: "stable",
    HOME_WORKER_UPDATE_TARGET: target,
  };
}

function loadReal(env: NodeJS.ProcessEnv = validEnv()) {
  return loadOtaConfig({
    mode: "real",
    env,
    platform: "linux",
    architecture: "arm",
    nodeModulesAbi: "115",
    runtimeLibcVersion: "2.28",
    nodeExecutable: "/usr/bin/node",
    validateFixedPaths: () => undefined,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadOtaDiscoveryConfig", () => {
  it("keeps the Task 5 loader name as the same config authority", () => {
    expect(loadOtaDiscoveryConfig).toBe(loadOtaConfig);
  });

  it.each([
    "HOME_WORKER_UPDATE_FEED_URL",
    "HOME_WORKER_UPDATE_TRUST_DIR",
    "HOME_WORKER_UPDATE_CHANNEL",
    "HOME_WORKER_UPDATE_TARGET",
  ] as const)("rejects a real-mode configuration missing %s", (key) => {
    const env = validEnv();
    delete env[key];

    expect(() => loadReal(env)).toThrow(key);
  });

  it.each([
    "http://updates.example.test/home-worker/stable/linux-armv7-glibc/update-envelope.json",
    "https://user:pass@updates.example.test/home-worker/stable/linux-armv7-glibc/update-envelope.json",
    "https://updates.example.test/home-worker/stable/linux-armv7-glibc/update-envelope.json?mirror=1",
    "https://updates.example.test/home-worker/stable/linux-armv7-glibc/update-envelope.json#latest",
    "https://updates.example.test/wrong/path/update-envelope.json",
  ])("rejects a non-canonical real-mode feed URL: %s", (feedUrl) => {
    const env = validEnv();
    env.HOME_WORKER_UPDATE_FEED_URL = feedUrl;

    expect(() => loadReal(env)).toThrow("HOME_WORKER_UPDATE_FEED_URL");
  });

  it("requires the stable channel exactly", () => {
    const env = validEnv();
    env.HOME_WORKER_UPDATE_CHANNEL = "beta";

    expect(() => loadReal(env)).toThrow("HOME_WORKER_UPDATE_CHANNEL");
  });

  it("requires the one compiled target compatible with the process architecture", () => {
    const env = validEnv("linux-arm64-glibc");

    expect(() => loadReal(env)).toThrow("HOME_WORKER_UPDATE_TARGET");
  });

  it("rejects unsupported real-mode runtime architectures", () => {
    expect(() =>
      loadOtaDiscoveryConfig({
        mode: "real",
        env: validEnv(),
        platform: "linux",
        architecture: "x64",
        nodeModulesAbi: "115",
        runtimeLibcVersion: "2.28",
        nodeExecutable: "/usr/bin/node",
        validateFixedPaths: () => undefined,
      }),
    ).toThrow("runtime");
  });

  it("requires an explicit absolute trust base containing a real active directory", () => {
    const relative = validEnv();
    relative.HOME_WORKER_UPDATE_TRUST_DIR = "relative/keys";
    expect(() => loadReal(relative)).toThrow("HOME_WORKER_UPDATE_TRUST_DIR");

    const missingActive = mkdtempSync(
      join(tmpdir(), "home-worker-ota-config-"),
    );
    temporaryDirectories.push(missingActive);
    const missing = validEnv();
    missing.HOME_WORKER_UPDATE_TRUST_DIR = missingActive;
    expect(() => loadReal(missing)).toThrow("active");

    const symlinkBase = mkdtempSync(join(tmpdir(), "home-worker-ota-config-"));
    temporaryDirectories.push(symlinkBase);
    mkdirSync(join(symlinkBase, "actual"));
    symlinkSync(join(symlinkBase, "actual"), join(symlinkBase, "active"));
    const symlinked = validEnv();
    symlinked.HOME_WORKER_UPDATE_TRUST_DIR = symlinkBase;
    expect(() => loadReal(symlinked)).toThrow("active");
  });

  it("returns one validated real-mode configuration for all OTA factories", () => {
    const env = validEnv();

    const config = loadReal(env);

    expect(config.feedUrl).toBe(env.HOME_WORKER_UPDATE_FEED_URL);
    expect(config.trustDirectory).toBe(env.HOME_WORKER_UPDATE_TRUST_DIR);
    expect(config.policy.channel).toBe("stable");
    expect(config.policy.target.targetName).toBe("linux-armv7-glibc");
    expect(config.policy.target.arch).toBe("arm");
    expect(config.policy.target.libcVersion).toBe("2.28");
    expect(config.checkOptions.feedUrl).toBe(config.feedUrl);
    expect(config.launcher.policy).toBe(config.policy);
    expect(config.launcher.requestDirectory).toBe("/run/home-worker/requests");
    expect(config.launcher.lockPath).toBe("/run/home-worker/ota.lock");
    expect(config.launcher.flockPath).toBe("/usr/bin/flock");
    expect(config.launcher.nodeExecutable).toBe("/usr/bin/node");
    expect(config.launcher.lockAcquiredShimEntry).toMatch(
      /system\/infrastructure\/ota-lock-acquired-shim\.js$/,
    );
    expect(config.updater.healthSeconds).toBe(60);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.policy)).toBe(true);
    expect(Object.isFrozen(config.policy.target)).toBe(true);
    expect(Object.isFrozen(config.launcher.environment)).toBe(true);
    expect(() => {
      (config.policy.target as { arch: string }).arch = "arm64";
    }).toThrow();
  });

  it("does not retain or reread the mutable environment after parsing", () => {
    const env = validEnv();
    env.HOME_WORKER_UPDATE_MAX_FILES = "10";
    env.HOME_WORKER_GLIBC_VERSION = "999.999";
    const config = loadReal(env);

    env.HOME_WORKER_UPDATE_MAX_FILES = "20000";
    env.TELEGRAM_BOT_TOKEN = "must-not-be-inherited";

    expect(config.policy.limits.maxFiles).toBe(10);
    expect(config.policy.target.libcVersion).toBe("2.28");
    expect(config.launcher.environment).toHaveProperty(
      "HOME_WORKER_UPDATE_RUNTIME_LIBC_VERSION",
      "2.28",
    );
    expect(config.launcher.environment).not.toHaveProperty(
      "HOME_WORKER_GLIBC_VERSION",
    );
    expect(config.launcher.environment).not.toHaveProperty(
      "TELEGRAM_BOT_TOKEN",
    );
  });

  it("startup-validates only the compiled launcher paths", () => {
    const seen: unknown[] = [];

    const config = loadOtaConfig({
      mode: "real",
      env: validEnv(),
      platform: "linux",
      architecture: "arm",
      nodeModulesAbi: "115",
      runtimeLibcVersion: "2.28",
      nodeExecutable: "/usr/bin/node",
      validateFixedPaths: (paths) => seen.push(paths),
    });

    expect(seen).toEqual([
      {
        flockPath: "/usr/bin/flock",
        nodeExecutable: "/usr/bin/node",
        lockPath: "/run/home-worker/ota.lock",
        requestDirectory: "/run/home-worker/requests",
        lockAcquiredShimEntry: expect.stringMatching(
          /system\/infrastructure\/ota-lock-acquired-shim\.js$/,
        ),
      },
    ]);
    expect(config.launcher.updaterEntry).toEqual(
      expect.stringMatching(/system\/infrastructure\/ota-updater\.entry\.js$/),
    );
  });

  it.each([
    undefined,
    "",
    "2",
    " 2.28",
    "2.28 ",
    "+2.28",
    "2.2e1",
    "02.28",
    "2.028",
    "2.٢٨",
    `2.${"1".repeat(31)}`,
  ])(
    "rejects malformed injected runtime libc %j before config creation",
    (value) => {
      expect(() =>
        loadOtaConfig({
          mode: "real",
          env: validEnv(),
          platform: "linux",
          architecture: "arm",
          nodeModulesAbi: "115",
          runtimeLibcVersion: value!,
          nodeExecutable: "/usr/bin/node",
          validateFixedPaths: () => undefined,
        }),
      ).toThrow(/libc/i);
    },
  );

  it.each([
    ["HOME_WORKER_UPDATE_POLL_MINUTES", 60, 24 * 60],
    [
      "HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES",
      100 * 1024 * 1024,
      100 * 1024 * 1024,
    ],
    [
      "HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES",
      512 * 1024 * 1024,
      512 * 1024 * 1024,
    ],
    ["HOME_WORKER_UPDATE_MAX_FILES", 20_000, 20_000],
    ["HOME_WORKER_UPDATE_HEALTH_SECONDS", 60, 300],
  ] as const)(
    "strictly parses %s with default %i and ceiling %i",
    (key, fallback, ceiling) => {
      const defaults = loadReal(validEnv());
      const numeric = {
        HOME_WORKER_UPDATE_POLL_MINUTES:
          defaults.discoveryOptions.pollIntervalMs / 60_000,
        HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES:
          defaults.policy.limits.maxArtifactBytes,
        HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES:
          defaults.policy.limits.maxExpandedBytes,
        HOME_WORKER_UPDATE_MAX_FILES: defaults.policy.limits.maxFiles,
        HOME_WORKER_UPDATE_HEALTH_SECONDS: defaults.updater.healthSeconds,
      };
      expect(numeric[key]).toBe(fallback);

      for (const value of ["", "0", "-1", "1.5", "1e2", "+1", " 1", "01"]) {
        const env = validEnv();
        env[key] = value;
        expect(() => loadReal(env)).toThrow(key);
      }

      const over = validEnv();
      over[key] = String(ceiling + 1);
      expect(() => loadReal(over)).toThrow(key);
    },
  );

  it("preserves the explicit stub/test branch without required production settings", () => {
    expect(() =>
      loadOtaDiscoveryConfig({
        mode: "stub",
        env: {},
        platform: "darwin",
        architecture: "arm64",
        nodeModulesAbi: "115",
        runtimeLibcVersion: "2.28",
      }),
    ).not.toThrow();
  });
});
