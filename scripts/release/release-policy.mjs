import { createHash } from "node:crypto";

export const RELEASE_TARGETS = Object.freeze({
  "linux-arm64-glibc": Object.freeze({
    platform: "linux",
    arch: "arm64",
    armVersion: null,
    libc: "glibc",
  }),
  "linux-armv7-glibc": Object.freeze({
    platform: "linux",
    arch: "arm",
    armVersion: 7,
    libc: "glibc",
  }),
});

const BUILDER_IDENTITY = "home-worker-linux-arm-builder-v1";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CACHE_PATH_PATTERN = /^\.yarn\/cache\/[^/]+\.zip$/u;

export function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeCacheInventory(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new TypeError("Cache inventory must contain at least one record");
  }

  const seen = new Set();
  const normalized = records.map((record) => {
    if (
      record === null ||
      typeof record !== "object" ||
      !CACHE_PATH_PATTERN.test(record.path) ||
      !Number.isSafeInteger(record.size) ||
      record.size <= 0 ||
      !SHA256_PATTERN.test(record.sha256)
    ) {
      throw new TypeError("Cache inventory contains an invalid record");
    }
    if (seen.has(record.path)) {
      throw new TypeError("Cache inventory contains a duplicate path");
    }
    seen.add(record.path);
    return { path: record.path, size: record.size, sha256: record.sha256 };
  });

  normalized.sort((left, right) => bytewiseCompare(left.path, right.path));
  return normalized;
}

export function computeCacheInventorySha256(records) {
  const canonical = normalizeCacheInventory(records)
    .map(({ path, size, sha256 }) => `${path}\0${size}\0${sha256}\n`)
    .join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function integerEpoch(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function immutableDecision(reasons) {
  const sortedReasons = Object.freeze(
    [...new Set(reasons)].sort(bytewiseCompare),
  );
  return Object.freeze({
    publishable: sortedReasons.length === 0,
    label: sortedReasons.length === 0 ? "publishable" : "nonpublishable",
    reasons: sortedReasons,
  });
}

export function evaluateReleasePolicy(facts) {
  const reasons = [];
  const request = facts?.request ?? {};
  const checkout = facts?.checkout ?? {};
  const packageFacts = facts?.package ?? {};
  const host = facts?.host ?? {};
  const builder = facts?.builder ?? {};
  const environment = facts?.environment ?? {};
  const cache = facts?.cache ?? {};
  const target = Object.hasOwn(RELEASE_TARGETS, request.target)
    ? RELEASE_TARGETS[request.target]
    : undefined;

  if (!matches(request.version, VERSION_PATTERN))
    reasons.push("request-version");
  if (!matches(request.commit, COMMIT_PATTERN)) reasons.push("request-commit");
  if (!target) reasons.push("request-target");
  if (request.tag !== `v${request.version}`) reasons.push("checkout-tag-name");

  if (checkout.clean !== true) reasons.push("checkout-dirty");
  if (checkout.headCommit !== request.commit) reasons.push("checkout-head");
  if (checkout.tagKind !== "tag") reasons.push("checkout-tag-kind");
  if (checkout.tagCommit !== request.commit)
    reasons.push("checkout-tag-commit");
  if (!integerEpoch(checkout.commitEpoch))
    reasons.push("checkout-commit-epoch");

  if (packageFacts.version !== request.version) reasons.push("package-version");
  if (packageFacts.releaseTarget !== request.target)
    reasons.push("package-target");
  if (packageFacts.packageManager !== "yarn@4.13.0") {
    reasons.push("package-manager");
  }

  if (host.platform !== target?.platform) reasons.push("host-platform");
  if (host.arch !== target?.arch) reasons.push("host-arch");
  if (host.libc !== target?.libc) reasons.push("host-libc");
  if (
    target &&
    target.armVersion !== null &&
    host.armVersion !== target.armVersion
  ) {
    reasons.push("host-arm-version");
  }
  if (host.nodeMajor !== 20) reasons.push("host-node-major");
  if (host.nodeModulesAbi !== "115") reasons.push("host-node-abi");

  if (builder.controlled !== true) reasons.push("builder-control");
  if (builder.identity !== BUILDER_IDENTITY) reasons.push("builder-identity");
  if (builder.target !== request.target) reasons.push("builder-target");
  if (builder.nodeMajor !== 20 || builder.nodeModulesAbi !== "115") {
    reasons.push("builder-runtime");
  }

  if (environment.tz !== "UTC") reasons.push("environment-tz");
  if (environment.locale !== "C") reasons.push("environment-locale");
  if (
    !integerEpoch(environment.sourceDateEpoch) ||
    environment.sourceDateEpoch !== checkout.commitEpoch
  ) {
    reasons.push("source-date-epoch");
  }

  if (cache.validated !== true) reasons.push("cache-validation");
  if (cache.target !== request.target) reasons.push("cache-target");
  if (cache.nodeMajor !== 20 || cache.nodeModulesAbi !== "115") {
    reasons.push("cache-runtime");
  }
  if (
    !matches(cache.yarnLockSha256, SHA256_PATTERN) ||
    cache.yarnLockSha256 !== cache.expectedYarnLockSha256
  ) {
    reasons.push("cache-lock");
  }
  try {
    if (
      !matches(cache.inventorySha256, SHA256_PATTERN) ||
      computeCacheInventorySha256(cache.inventory) !== cache.inventorySha256
    ) {
      reasons.push("cache-inventory");
    }
  } catch {
    reasons.push("cache-inventory");
  }

  return immutableDecision(reasons);
}
