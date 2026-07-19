const POLICY_KEYS = ["schemaVersion", "identity", "target", "runtime"];
const TARGET_KEYS = [
  "targetName",
  "platform",
  "arch",
  "libc",
  "libcVersion",
  "nodeModulesAbi",
];
const RUNTIME_KEYS = ["nodeMajor", "packageManager"];
const LIBC_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/u;

export function validateBuilderPolicyOwnership(stat) {
  if (!stat?.isFile?.() || stat.isSymbolicLink?.()) {
    throw new Error("Builder policy must be a regular file");
  }
  if (stat.uid !== 0n) {
    throw new Error("Builder policy must be root-owned");
  }
  if ((stat.mode & 0o22n) !== 0n) {
    throw new Error("Builder policy must not be group/world writable");
  }
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function normalizeBuilderPolicy(value) {
  if (
    !exactKeys(value, POLICY_KEYS) ||
    !exactKeys(value.target, TARGET_KEYS) ||
    !exactKeys(value.runtime, RUNTIME_KEYS) ||
    value.schemaVersion !== 1 ||
    value.identity !== "home-worker-linux-arm-builder-v1" ||
    value.target.targetName !== "linux-arm64-glibc" ||
    value.target.platform !== "linux" ||
    value.target.arch !== "arm64" ||
    value.target.libc !== "glibc" ||
    typeof value.target.libcVersion !== "string" ||
    !LIBC_VERSION.test(value.target.libcVersion) ||
    value.target.nodeModulesAbi !== "115" ||
    value.runtime.nodeMajor !== 20 ||
    value.runtime.packageManager !== "yarn@4.13.0"
  ) {
    throw new Error("Invalid ARM64 release builder policy");
  }

  return {
    schemaVersion: 1,
    identity: value.identity,
    target: { ...value.target },
    runtime: { ...value.runtime },
  };
}

function immutablePolicy(value) {
  Object.freeze(value.target);
  Object.freeze(value.runtime);
  return Object.freeze(value);
}

export function encodeBuilderPolicy(value) {
  const normalized = normalizeBuilderPolicy(value);
  return Buffer.from(`${JSON.stringify(normalized)}\n`, "utf8");
}

export function parseBuilderPolicy(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > 16 * 1024
  ) {
    throw new Error("Invalid release builder policy bytes");
  }
  let source;
  let parsed;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Invalid release builder policy JSON");
  }
  const normalized = normalizeBuilderPolicy(parsed);
  if (source !== `${JSON.stringify(normalized)}\n`) {
    throw new Error("Release builder policy is not canonical");
  }
  return immutablePolicy(normalized);
}
