import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const OTA_POLICY_PATH = "/etc/home-worker/ota-policy.json";
export const STARTUP_REPORT_PATH =
  "/opt/home-worker/shared/update/startup-report.pending.json";
const MAX_POLICY_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const ABI = /^(?:0|[1-9]\d*)$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{22}$/;
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DOTTED = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/;
const FAILURE_CODES = new Set([
  "clock-unsynchronized",
  "clock-rollback",
  "network-unavailable",
  "network-timeout",
  "redirect-rejected",
  "http-status",
  "envelope-too-large",
  "envelope-malformed",
  "trust-key-missing",
  "trust-key-invalid",
  "signature-invalid",
  "metadata-rollback",
  "metadata-equivocation",
  "metadata-expired",
  "metadata-freeze",
  "schema-invalid",
  "target-incompatible",
  "runtime-incompatible",
  "disk-resource",
  "archive-integrity",
  "archive-policy",
  "dependency-sandbox",
  "dependency-install",
  "cache-mutation",
  "prepared-tree",
  "migration",
  "activation",
  "pm2",
  "readiness",
  "restart-loop",
  "rollback",
  "operation-in-progress",
  "trust-state-lost",
  "maintenance-required",
]);
const HARD_LIMITS = {
  maxArtifactBytes: 100 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxPreparedBytes: 1024 * 1024 * 1024,
  maxPreparedFiles: 200_000,
  maxFiles: 20_000,
};

function fail() {
  throw new Error("invalid root OTA contract");
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function validateRootPolicy(value) {
  if (
    !exactKeys(value, ["feedUrl", "channel", "target", "runtime", "limits"]) ||
    value.channel !== "stable" ||
    !exactKeys(value.target, [
      "targetName",
      "platform",
      "arch",
      "libc",
      "libcVersion",
      "nodeModulesAbi",
    ]) ||
    value.target.platform !== "linux" ||
    (value.target.arch !== "arm" && value.target.arch !== "arm64") ||
    value.target.libc !== "glibc" ||
    value.target.targetName !==
      (value.target.arch === "arm"
        ? "linux-armv7-glibc"
        : "linux-arm64-glibc") ||
    typeof value.target.libcVersion !== "string" ||
    value.target.libcVersion.length > 32 ||
    !DOTTED.test(value.target.libcVersion) ||
    typeof value.target.nodeModulesAbi !== "string" ||
    !ABI.test(value.target.nodeModulesAbi) ||
    !exactKeys(value.runtime, ["nodeMajor", "packageManager"]) ||
    value.runtime.nodeMajor !== 20 ||
    value.runtime.packageManager !== "yarn@4.13.0" ||
    !exactKeys(value.limits, Object.keys(HARD_LIMITS))
  )
    fail();
  for (const [key, maximum] of Object.entries(HARD_LIMITS)) {
    if (!positive(value.limits[key]) || value.limits[key] > maximum) fail();
  }
  let feed;
  try {
    feed = new URL(value.feedUrl);
  } catch {
    fail();
  }
  if (
    feed.protocol !== "https:" ||
    feed.username !== "" ||
    feed.password !== "" ||
    feed.search !== "" ||
    feed.hash !== "" ||
    feed.pathname !==
      `/home-worker/stable/${value.target.targetName}/update-envelope.json` ||
    feed.href !== value.feedUrl
  )
    fail();
  return structuredClone(value);
}

function policyPayload(policy) {
  return { schemaVersion: 1, policy };
}

function policyDocument(policy) {
  const payload = policyPayload(validateRootPolicy(policy));
  return {
    ...payload,
    checksum: createHash("sha256")
      .update(JSON.stringify(payload), "utf8")
      .digest("hex"),
  };
}

async function syncDirectory(path) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeRootPolicy(policy, options = {}) {
  const path = options.path ?? OTA_POLICY_PATH;
  const uid = options.uid ?? 0;
  const gid = options.gid ?? 0;
  const document = policyDocument(policy);
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  const temporary = join(dirname(path), `.ota-policy.${process.pid}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chown(uid, gid);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

export async function loadRootPolicy(options = {}) {
  const path = options.path ?? OTA_POLICY_PATH;
  const uid = options.uid ?? 0;
  const gid = options.gid ?? 0;
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    info.gid !== gid ||
    (info.mode & 0o022) !== 0 ||
    info.size < 1 ||
    info.size > MAX_POLICY_BYTES
  )
    fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      fail();
    let text;
    let document;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      document = JSON.parse(text);
    } catch {
      fail();
    }
    if (
      !exactKeys(document, ["schemaVersion", "policy", "checksum"]) ||
      document.schemaVersion !== 1 ||
      !SHA256.test(document.checksum) ||
      text !== JSON.stringify(document)
    )
      fail();
    const policy = validateRootPolicy(document.policy);
    const payload = policyPayload(policy);
    if (
      createHash("sha256").update(JSON.stringify(payload)).digest("hex") !==
      document.checksum
    )
      fail();
    return policy;
  } finally {
    await handle.close();
  }
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const parsed = new Date(Date.parse(value));
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validTarget(value) {
  return (
    exactKeys(value, [
      "platform",
      "arch",
      "libc",
      "libcMinVersion",
      "nodeModulesAbi",
    ]) &&
    value.platform === "linux" &&
    (value.arch === "arm" || value.arch === "arm64") &&
    value.libc === "glibc" &&
    typeof value.libcMinVersion === "string" &&
    DOTTED.test(value.libcMinVersion) &&
    typeof value.nodeModulesAbi === "string" &&
    ABI.test(value.nodeModulesAbi)
  );
}

function validExpected(value) {
  if (!exactKeys(value, ["artifact", "metadata"])) return false;
  const artifact = value.artifact;
  const metadata = value.metadata;
  if (
    !exactKeys(artifact, [
      "version",
      "commit",
      "targetName",
      "target",
      "url",
      "format",
      "size",
      "expandedSize",
      "maxPreparedSize",
      "maxPreparedFiles",
      "fileCount",
      "sha256",
    ]) ||
    typeof artifact.version !== "string" ||
    artifact.version.length < 1 ||
    artifact.version.length > 128 ||
    typeof artifact.commit !== "string" ||
    artifact.commit.length < 1 ||
    artifact.commit.length > 256 ||
    !validTarget(artifact.target) ||
    artifact.targetName !==
      (artifact.target.arch === "arm"
        ? "linux-armv7-glibc"
        : "linux-arm64-glibc") ||
    typeof artifact.url !== "string" ||
    artifact.url.length < 1 ||
    artifact.url.length > 4096 ||
    artifact.format !== "tar.gz" ||
    !positive(artifact.size) ||
    !positive(artifact.expandedSize) ||
    !positive(artifact.maxPreparedSize) ||
    !positive(artifact.maxPreparedFiles) ||
    !positive(artifact.fileCount) ||
    !SHA256.test(artifact.sha256) ||
    !exactKeys(metadata, [
      "metadataVersion",
      "channel",
      "payloadSha256",
      "publishedAt",
      "expiresAt",
    ]) ||
    !positive(metadata.metadataVersion) ||
    metadata.channel !== "stable" ||
    !SHA256.test(metadata.payloadSha256) ||
    !canonicalTimestamp(metadata.publishedAt) ||
    !canonicalTimestamp(metadata.expiresAt)
  )
    return false;
  return true;
}

function journalPayload(value) {
  return {
    schemaVersion: value.schemaVersion,
    generation: value.generation,
    operationId: value.operationId,
    kind: value.kind,
    phase: value.phase,
    expected: value.expected,
    acceptedAt: value.acceptedAt,
    requestSha256: value.requestSha256,
    receiptGeneration: value.receiptGeneration,
    priorCurrent: value.priorCurrent,
    priorPrevious: value.priorPrevious,
    candidate: value.candidate,
    preparedTreeSha256: value.preparedTreeSha256,
    diagnostics: value.diagnostics,
    updatedAt: value.updatedAt,
  };
}

function validJournal(value) {
  const phases = new Set([
    "preparing",
    "prepared",
    "failed_pre_activation",
    "activating",
    "activated",
    "rolled_back",
    "rollback_failed",
    "healthy",
    "cleanup_pending",
  ]);
  const releaseOrNull = (entry) => entry === null || RELEASE.test(entry);
  const payload = journalPayload(value);
  return (
    exactKeys(value, [...Object.keys(payload), "checksum"]) &&
    value.schemaVersion === 1 &&
    positive(value.generation) &&
    OPERATION_ID.test(value.operationId) &&
    Buffer.from(value.operationId, "base64url").length === 16 &&
    Buffer.from(value.operationId, "base64url").toString("base64url") ===
      value.operationId &&
    (value.kind === "update" || value.kind === "rollback") &&
    ((value.kind === "update" && validExpected(value.expected)) ||
      (value.kind === "rollback" && value.expected === null)) &&
    phases.has(value.phase) &&
    canonicalTimestamp(value.acceptedAt) &&
    SHA256.test(value.requestSha256) &&
    positive(value.receiptGeneration) &&
    releaseOrNull(value.priorCurrent) &&
    releaseOrNull(value.priorPrevious) &&
    releaseOrNull(value.candidate) &&
    (value.preparedTreeSha256 === null ||
      SHA256.test(value.preparedTreeSha256)) &&
    exactKeys(value.diagnostics, ["code", "notes"]) &&
    (value.diagnostics.code === null ||
      FAILURE_CODES.has(value.diagnostics.code)) &&
    Array.isArray(value.diagnostics.notes) &&
    value.diagnostics.notes.length <= 16 &&
    value.diagnostics.notes.every(
      (note) =>
        typeof note === "string" &&
        /^[\x20-\x7e]*$/.test(note) &&
        Buffer.byteLength(note) <= 512,
    ) &&
    canonicalTimestamp(value.updatedAt) &&
    SHA256.test(value.checksum) &&
    createHash("sha256").update(JSON.stringify(payload)).digest("hex") ===
      value.checksum
  );
}

async function readCanonicalFile(path, uid, maximum) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== uid ||
    (info.mode & 0o022) !== 0 ||
    info.size < 1 ||
    info.size > maximum
  )
    fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      fail();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (text !== JSON.stringify(value)) fail();
    return value;
  } finally {
    await handle.close();
  }
}

export async function loadOperationJournal(options = {}) {
  const directory = options.directory ?? "/opt/home-worker/shared/update";
  const uid = options.uid ?? process.getuid();
  const directoryInfo = await lstat(directory);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    directoryInfo.uid !== uid ||
    (directoryInfo.mode & 0o777) !== 0o700
  )
    fail();
  const slots = [];
  let missing = 0;
  for (const name of ["operation-a.json", "operation-b.json"]) {
    try {
      const value = await readCanonicalFile(
        join(directory, name),
        uid,
        2 * 1024 * 1024,
      );
      if (!validJournal(value)) fail();
      slots.push(value);
    } catch (error) {
      if (error?.code === "ENOENT") missing += 1;
      else slots.push(null);
    }
  }
  if (missing === 2) return null;
  if (slots.includes(null) && slots.filter(Boolean).length === 0) fail();
  const valid = slots.filter(Boolean);
  if (valid.length === 0) fail();
  valid.sort((left, right) => left.generation - right.generation);
  if (
    valid.length === 2 &&
    valid[0].generation === valid[1].generation &&
    valid[0].checksum !== valid[1].checksum
  )
    fail();
  if (valid.length === 2 && valid[0].generation !== valid[1].generation) {
    const previous = valid[0];
    const next = valid[1];
    const allowed = {
      preparing: ["prepared", "failed_pre_activation"],
      prepared: ["activating", "cleanup_pending"],
      failed_pre_activation: [],
      activating: ["activated", "rolled_back", "rollback_failed"],
      activated: ["healthy", "rolled_back", "rollback_failed"],
      rolled_back: [],
      rollback_failed: [],
      healthy: ["cleanup_pending"],
      cleanup_pending: [],
    };
    const immutable = [
      "operationId",
      "kind",
      "expected",
      "acceptedAt",
      "requestSha256",
      "receiptGeneration",
      "priorCurrent",
      "priorPrevious",
      "candidate",
    ];
    if (
      next.generation !== previous.generation + 1 ||
      !allowed[previous.phase]?.includes(next.phase) ||
      immutable.some(
        (key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]),
      )
    )
      fail();
  }
  return valid.at(-1);
}

function validStartupReport(report) {
  const identityNull =
    report.operationId === null &&
    report.kind === null &&
    report.artifactSha256 === null &&
    report.metadataSha256 === null;
  const identityComplete =
    OPERATION_ID.test(report.operationId) &&
    (report.kind === "update" || report.kind === "rollback") &&
    SHA256.test(report.artifactSha256) &&
    SHA256.test(report.metadataSha256);
  return (
    exactKeys(report, [
      "schemaVersion",
      "operationId",
      "kind",
      "outcome",
      "artifactSha256",
      "metadataSha256",
      "failure",
      "writtenAt",
    ]) &&
    report.schemaVersion === 1 &&
    ["updated", "rolled-back", "failed", "maintenance-required"].includes(
      report.outcome,
    ) &&
    (identityComplete ||
      (identityNull && report.outcome === "maintenance-required")) &&
    ((report.failure === null &&
      (report.outcome === "updated" || report.outcome === "rolled-back")) ||
      (exactKeys(report.failure, ["code"]) &&
        FAILURE_CODES.has(report.failure.code) &&
        (report.outcome === "failed" ||
          report.outcome === "maintenance-required"))) &&
    canonicalTimestamp(report.writtenAt)
  );
}

export async function writeStartupReport(report, options = {}) {
  if (!validStartupReport(report)) fail();
  const path = options.path ?? STARTUP_REPORT_PATH;
  const uid = options.uid ?? process.getuid();
  const gid = options.gid ?? process.getgid();
  const bytes = Buffer.from(JSON.stringify(report));
  if (bytes.length > 64 * 1024) fail();
  const temporary = join(dirname(path), `.startup-report.${process.pid}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chown(uid, gid);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

function parseEnvironment(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match !== null) values.set(match[1], match[2]);
  }
  return values;
}

function decimal(values, key, fallback) {
  const source = values.get(key) ?? String(fallback);
  if (!/^[1-9]\d*$/.test(source)) fail();
  const value = Number(source);
  if (!Number.isSafeInteger(value)) fail();
  return value;
}

export async function installRootPolicyFromConfiguration() {
  const values = parseEnvironment(
    await readFile("/opt/home-worker/.env", "utf8"),
  );
  const arch = process.arch;
  if (process.platform !== "linux" || (arch !== "arm" && arch !== "arm64"))
    fail();
  const targetName = arch === "arm" ? "linux-armv7-glibc" : "linux-arm64-glibc";
  if (
    values.get("HOME_WORKER_UPDATE_CHANNEL") !== "stable" ||
    values.get("HOME_WORKER_UPDATE_TARGET") !== targetName
  )
    fail();
  const report = process.report.getReport();
  const libcVersion = report.header?.glibcVersionRuntime;
  if (typeof libcVersion !== "string") fail();
  await writeRootPolicy({
    feedUrl: values.get("HOME_WORKER_UPDATE_FEED_URL"),
    channel: "stable",
    target: {
      targetName,
      platform: "linux",
      arch,
      libc: "glibc",
      libcVersion,
      nodeModulesAbi: process.versions.modules,
    },
    runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
    limits: {
      maxArtifactBytes: decimal(
        values,
        "HOME_WORKER_UPDATE_MAX_ARTIFACT_BYTES",
        HARD_LIMITS.maxArtifactBytes,
      ),
      maxExpandedBytes: decimal(
        values,
        "HOME_WORKER_UPDATE_MAX_EXPANDED_BYTES",
        HARD_LIMITS.maxExpandedBytes,
      ),
      maxPreparedBytes: HARD_LIMITS.maxPreparedBytes,
      maxPreparedFiles: HARD_LIMITS.maxPreparedFiles,
      maxFiles: decimal(
        values,
        "HOME_WORKER_UPDATE_MAX_FILES",
        HARD_LIMITS.maxFiles,
      ),
    },
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  if (process.argv.length !== 3 || process.argv[2] !== "install-policy") {
    process.exit(64);
  }
  installRootPolicyFromConfiguration().catch(() => process.exit(75));
}
