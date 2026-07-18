import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOtaDiscoveryConfig } from "../../../src/system/infrastructure/ota-discovery-config.loader";

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
  return loadOtaDiscoveryConfig({
    mode: "real",
    env,
    platform: "linux",
    architecture: "arm",
    nodeModulesAbi: "115",
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadOtaDiscoveryConfig", () => {
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
    expect(config.checkOptions.feedUrl).toBe(config.feedUrl);
  });

  it("preserves the explicit stub/test branch without required production settings", () => {
    expect(() =>
      loadOtaDiscoveryConfig({
        mode: "stub",
        env: {},
        platform: "darwin",
        architecture: "arm64",
        nodeModulesAbi: "115",
      }),
    ).not.toThrow();
  });
});
