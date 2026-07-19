import { createHash, createPublicKey, verify } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  lchown,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const INSTALL_ROOT = "/opt/home-worker";
const RELEASES_ROOT = "/opt/home-worker/releases";
const JOURNAL_ROOT = "/opt/home-worker/shared/update";
const PROJECTION_ROOT = "/run/home-worker/activate";
const READY_PATH = "/run/home-worker/ready.json";
const TRUST_ROOT = "/etc/home-worker/update-keys";
const OPERATION_ID = /^[A-Za-z0-9_-]{22}$/;
const RELEASE_NAME = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 96 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_PREPARED_BYTES = 1024 * 1024 * 1024;
const MAX_PREPARED_FILES = 200_000;
const MAX_FILES = 20_000;
const COMMIT = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ABI = /^(?:0|[1-9]\d*)$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MARKERS = new Set([
  "artifact-state.json",
  "artifact-envelope.json",
  "known-good.json",
]);
const HOMEWORKER_ENV = {
  HOME: "/home/homeworker",
  PM2_HOME: "/home/homeworker/.pm2",
  PATH: "/usr/bin:/bin",
  NODE_ENV: "production",
  LANG: "C",
  LC_ALL: "C",
};

export class ActivationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ActivationError";
    Object.defineProperty(this, "code", { value: code, enumerable: true });
  }
}

function fail(code = "maintenance-required") {
  throw new ActivationError(code);
}

function canonicalOperationId(value) {
  if (!OPERATION_ID.test(value)) fail();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== value) fail();
  return value;
}

async function readBytes(path, maximum = MAX_JSON_BYTES) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) fail();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      fail();
    }
    return bytes;
  } catch (error) {
    if (error instanceof ActivationError) throw error;
    fail();
  } finally {
    await handle.close();
  }
}

async function readJson(path, maximum = MAX_JSON_BYTES) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBytes(path, maximum),
      ),
    );
  } catch (error) {
    if (error instanceof ActivationError) throw error;
    fail();
  }
}

function releaseOrNull(value) {
  return (
    value === null || (typeof value === "string" && RELEASE_NAME.test(value))
  );
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function canonicalDottedVersion(value) {
  return (
    typeof value === "string" &&
    value.length <= 32 &&
    Buffer.byteLength(value, "utf8") === value.length &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/.test(value)
  );
}

function compareDottedVersions(left, right) {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function parseRootPolicy(value) {
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
    !canonicalDottedVersion(value.target.libcVersion) ||
    typeof value.target.nodeModulesAbi !== "string" ||
    !ABI.test(value.target.nodeModulesAbi) ||
    !exactKeys(value.runtime, ["nodeMajor", "packageManager"]) ||
    value.runtime.nodeMajor !== 20 ||
    value.runtime.packageManager !== "yarn@4.13.0" ||
    !exactKeys(value.limits, [
      "maxArtifactBytes",
      "maxExpandedBytes",
      "maxPreparedBytes",
      "maxPreparedFiles",
      "maxFiles",
    ]) ||
    !positiveInteger(value.limits.maxArtifactBytes) ||
    value.limits.maxArtifactBytes > MAX_ARTIFACT_BYTES ||
    !positiveInteger(value.limits.maxExpandedBytes) ||
    value.limits.maxExpandedBytes > MAX_EXPANDED_BYTES ||
    !positiveInteger(value.limits.maxPreparedBytes) ||
    value.limits.maxPreparedBytes > MAX_PREPARED_BYTES ||
    !positiveInteger(value.limits.maxPreparedFiles) ||
    value.limits.maxPreparedFiles > MAX_PREPARED_FILES ||
    !positiveInteger(value.limits.maxFiles) ||
    value.limits.maxFiles > MAX_FILES
  )
    fail();
  let feedUrl;
  try {
    feedUrl = new URL(value.feedUrl);
  } catch {
    fail();
  }
  const expectedPath = `/home-worker/stable/${value.target.targetName}/update-envelope.json`;
  if (
    feedUrl.protocol !== "https:" ||
    feedUrl.username !== "" ||
    feedUrl.password !== "" ||
    feedUrl.search !== "" ||
    feedUrl.hash !== "" ||
    feedUrl.pathname !== expectedPath ||
    feedUrl.href !== value.feedUrl
  )
    fail();
  return value;
}

function canonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function canonicalBase64(value) {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(value)
  )
    fail();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail();
  return bytes;
}

function parseSecurityJson(bytes) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    fail();
  }
  if (source.startsWith("\uFEFF")) fail();

  let index = 0;
  let depth = 0;
  const whitespace = new Set([" ", "\t", "\n", "\r"]);
  const skip = () => {
    while (whitespace.has(source[index] ?? "")) index += 1;
  };
  const consume = (character) => {
    if (source[index] !== character) return false;
    index += 1;
    return true;
  };
  const parseString = () => {
    const start = index;
    index += 1;
    while (index < source.length) {
      const code = source.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          fail();
        }
      }
      if (code < 0x20) fail();
      if (code === 0x5c) {
        index += 1;
        const escape = source[index];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5)))
            fail();
          index += 5;
          continue;
        }
        if (!['"', "\\", "/", "b", "f", "n", "r", "t"].includes(escape)) fail();
      }
      index += 1;
    }
    fail();
  };
  const parseNumber = () => {
    const token = /^-?(?:0|[1-9]\d*)/.exec(source.slice(index))?.[0];
    if (!token) fail();
    index += token.length;
    const value = Number(token);
    if (!Number.isSafeInteger(value)) fail();
    return value;
  };
  const enter = () => {
    if (depth >= 64) fail();
    depth += 1;
  };
  let parseValue;
  const parseObject = () => {
    enter();
    index += 1;
    skip();
    const result = {};
    const keys = new Set();
    if (consume("}")) {
      depth -= 1;
      return result;
    }
    while (true) {
      skip();
      if (source[index] !== '"') fail();
      const key = parseString();
      if (keys.has(key)) fail();
      keys.add(key);
      skip();
      if (!consume(":")) fail();
      Object.defineProperty(result, key, {
        value: parseValue(),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      skip();
      if (consume("}")) {
        depth -= 1;
        return result;
      }
      if (!consume(",")) fail();
    }
  };
  const parseArray = () => {
    enter();
    index += 1;
    skip();
    const result = [];
    if (consume("]")) {
      depth -= 1;
      return result;
    }
    while (true) {
      result.push(parseValue());
      skip();
      if (consume("]")) {
        depth -= 1;
        return result;
      }
      if (!consume(",")) fail();
    }
  };
  parseValue = () => {
    skip();
    const character = source[index];
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (character === '"') return parseString();
    for (const [token, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (source.slice(index, index + token.length) === token) {
        index += token.length;
        return value;
      }
    }
    if (character === "-" || /\d/.test(character ?? "")) return parseNumber();
    fail();
  };
  const value = parseValue();
  skip();
  if (index !== source.length) fail();
  return value;
}

function parseSignedManifest(payload, now, enforceFreshness, policy) {
  const manifest = parseSecurityJson(payload);
  if (
    !exactKeys(manifest, [
      "schemaVersion",
      "metadataVersion",
      "channel",
      "version",
      "commit",
      "publishedAt",
      "expiresAt",
      "target",
      "artifact",
      "runtime",
    ]) ||
    manifest.schemaVersion !== 1 ||
    !positiveInteger(manifest.metadataVersion) ||
    manifest.channel !== policy.channel ||
    typeof manifest.version !== "string" ||
    manifest.version.length > 64 ||
    !SEMVER.test(manifest.version) ||
    typeof manifest.commit !== "string" ||
    !COMMIT.test(manifest.commit) ||
    !canonicalTimestamp(manifest.publishedAt) ||
    !canonicalTimestamp(manifest.expiresAt) ||
    Date.parse(manifest.publishedAt) >= Date.parse(manifest.expiresAt) ||
    Date.parse(manifest.expiresAt) - Date.parse(manifest.publishedAt) >
      31 * 24 * 60 * 60 * 1000 ||
    (enforceFreshness &&
      (Date.parse(manifest.publishedAt) > now.getTime() + 5 * 60 * 1000 ||
        Date.parse(manifest.expiresAt) <= now.getTime()))
  )
    fail();
  if (
    !exactKeys(manifest.target, [
      "platform",
      "arch",
      "libc",
      "libcMinVersion",
      "nodeModulesAbi",
    ]) ||
    manifest.target.platform !== policy.target.platform ||
    manifest.target.arch !== policy.target.arch ||
    manifest.target.libc !== policy.target.libc ||
    !canonicalDottedVersion(manifest.target.libcMinVersion) ||
    compareDottedVersions(
      manifest.target.libcMinVersion,
      policy.target.libcVersion,
    ) > 0 ||
    typeof manifest.target.nodeModulesAbi !== "string" ||
    !ABI.test(manifest.target.nodeModulesAbi) ||
    manifest.target.nodeModulesAbi !== policy.target.nodeModulesAbi
  )
    fail();
  if (
    !exactKeys(manifest.artifact, [
      "url",
      "format",
      "size",
      "expandedSize",
      "maxPreparedSize",
      "maxPreparedFiles",
      "fileCount",
      "sha256",
    ]) ||
    typeof manifest.artifact.url !== "string" ||
    manifest.artifact.format !== "tar.gz" ||
    !positiveInteger(manifest.artifact.size) ||
    !positiveInteger(manifest.artifact.expandedSize) ||
    !positiveInteger(manifest.artifact.maxPreparedSize) ||
    !positiveInteger(manifest.artifact.maxPreparedFiles) ||
    !positiveInteger(manifest.artifact.fileCount) ||
    !SHA256.test(manifest.artifact.sha256) ||
    manifest.artifact.size > policy.limits.maxArtifactBytes ||
    manifest.artifact.expandedSize > policy.limits.maxExpandedBytes ||
    manifest.artifact.maxPreparedSize > policy.limits.maxPreparedBytes ||
    manifest.artifact.maxPreparedFiles > policy.limits.maxPreparedFiles ||
    manifest.artifact.fileCount > policy.limits.maxFiles ||
    manifest.artifact.expandedSize > manifest.artifact.maxPreparedSize ||
    manifest.artifact.fileCount > manifest.artifact.maxPreparedFiles
  )
    fail();
  try {
    const url = new URL(manifest.artifact.url);
    const feedUrl = new URL(policy.feedUrl);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.origin !== feedUrl.origin
    )
      fail();
  } catch (error) {
    if (error instanceof ActivationError) throw error;
    fail();
  }
  if (
    !exactKeys(manifest.runtime, ["nodeMajor", "packageManager"]) ||
    manifest.runtime.nodeMajor !== policy.runtime.nodeMajor ||
    manifest.runtime.packageManager !== policy.runtime.packageManager
  )
    fail();
  return manifest;
}

async function loadVerificationKeys(trustRoot, scope, expectedUid) {
  const directory = resolve(trustRoot, scope);
  let directoryInfo;
  try {
    directoryInfo = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    directoryInfo.uid !== expectedUid ||
    (directoryInfo.mode & 0o022) !== 0
  )
    fail();
  const keys = new Map();
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".pem") || name.includes("/")) continue;
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== expectedUid ||
        (info.mode & 0o022) !== 0
      )
        continue;
      const publicKey = createPublicKey(await readBytes(path, 64 * 1024));
      if (
        publicKey.type !== "public" ||
        publicKey.asymmetricKeyType !== "ed25519"
      )
        continue;
      const keyId = createHash("sha256")
        .update(publicKey.export({ format: "der", type: "spki" }))
        .digest("hex");
      if (!keys.has(keyId)) keys.set(keyId, publicKey);
    } catch {}
  }
  return keys;
}

function checkedIdentity(manifest, payloadSha256, targetName) {
  return {
    artifact: {
      version: manifest.version,
      commit: manifest.commit,
      targetName,
      target: manifest.target,
      ...manifest.artifact,
    },
    metadata: {
      metadataVersion: manifest.metadataVersion,
      channel: manifest.channel,
      payloadSha256,
      publishedAt: manifest.publishedAt,
      expiresAt: manifest.expiresAt,
    },
  };
}

function sameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameJson(left[key], right[key]),
    )
  );
}

export async function verifyCandidateAuthorization(
  journal,
  marker,
  envelopeBytes,
  knownGood,
  options = {},
) {
  try {
    const trustRoot = options.trustRoot ?? TRUST_ROOT;
    const expectedUid =
      options.expectedUid ?? (trustRoot === TRUST_ROOT ? 0 : process.getuid());
    const now = options.now ?? new Date();
    const policy = parseRootPolicy(options.policy);
    if (
      !Number.isFinite(now.getTime()) ||
      envelopeBytes.byteLength > MAX_ENVELOPE_BYTES ||
      !exactKeys(marker, [
        "schemaVersion",
        "artifact",
        "metadata",
        "envelopeSha256",
        "preparedTreeSha256",
        "writtenAt",
      ]) ||
      marker.schemaVersion !== 1 ||
      marker.envelopeSha256 !==
        createHash("sha256").update(envelopeBytes).digest("hex")
    )
      fail();
    const envelope = parseSecurityJson(envelopeBytes);
    if (
      !exactKeys(envelope, ["payload", "signatures"]) ||
      !Array.isArray(envelope.signatures) ||
      envelope.signatures.length < 1 ||
      envelope.signatures.length > 3
    )
      fail();
    const payload = canonicalBase64(envelope.payload);
    if (payload.byteLength > MAX_PAYLOAD_BYTES) fail();
    const seen = new Set();
    const signatures = envelope.signatures.map((entry) => {
      if (
        !exactKeys(entry, ["keyId", "signature"]) ||
        typeof entry.keyId !== "string" ||
        !SHA256.test(entry.keyId) ||
        seen.has(entry.keyId)
      )
        fail();
      seen.add(entry.keyId);
      const signature = canonicalBase64(entry.signature);
      if (signature.byteLength !== 64) fail();
      return { keyId: entry.keyId, signature };
    });
    const manifest = parseSignedManifest(
      payload,
      now,
      journal.kind === "update",
      policy,
    );
    const identity = checkedIdentity(
      manifest,
      createHash("sha256").update(payload).digest("hex"),
      policy.target.targetName,
    );
    if (
      !sameJson(identity, {
        artifact: marker.artifact,
        metadata: marker.metadata,
      })
    )
      fail();
    const active = await loadVerificationKeys(trustRoot, "active", expectedUid);
    const verifiesWith = (keys) =>
      signatures.some(({ keyId, signature }) => {
        const key = keys.get(keyId);
        return key !== undefined && verify(null, payload, key, signature);
      });
    if (journal.kind === "update") {
      if (!sameJson(identity, journal.expected) || !verifiesWith(active))
        fail();
    } else {
      const retired = await loadVerificationKeys(
        trustRoot,
        "retired",
        expectedUid,
      );
      if (
        !exactKeys(knownGood, [
          "schemaVersion",
          "operationId",
          "artifactSha256",
          "metadataSha256",
          "preparedTreeSha256",
          "activatedAt",
        ]) ||
        knownGood.schemaVersion !== 1 ||
        !OPERATION_ID.test(knownGood.operationId) ||
        Buffer.from(knownGood.operationId, "base64url").length !== 16 ||
        Buffer.from(knownGood.operationId, "base64url").toString(
          "base64url",
        ) !== knownGood.operationId ||
        knownGood.artifactSha256 !== identity.artifact.sha256 ||
        knownGood.metadataSha256 !== identity.metadata.payloadSha256 ||
        knownGood.preparedTreeSha256 !== marker.preparedTreeSha256 ||
        !canonicalTimestamp(knownGood.activatedAt) ||
        (!verifiesWith(active) && !verifiesWith(retired))
      )
        fail();
    }
    return {
      artifactSha256: identity.artifact.sha256,
      metadataSha256: identity.metadata.payloadSha256,
    };
  } catch (error) {
    if (error instanceof ActivationError) throw error;
    fail();
  }
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

function validJournal(value, operationId, phase = "prepared") {
  const payload = journalPayload(value);
  return (
    exactKeys(value, [
      "schemaVersion",
      "generation",
      "operationId",
      "kind",
      "phase",
      "expected",
      "acceptedAt",
      "requestSha256",
      "receiptGeneration",
      "priorCurrent",
      "priorPrevious",
      "candidate",
      "preparedTreeSha256",
      "diagnostics",
      "updatedAt",
      "checksum",
    ]) &&
    value.schemaVersion === 1 &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    value.operationId === operationId &&
    value.phase === phase &&
    (value.kind === "update" || value.kind === "rollback") &&
    ((value.kind === "update" && value.expected !== null) ||
      (value.kind === "rollback" && value.expected === null)) &&
    RELEASE_NAME.test(value.candidate) &&
    releaseOrNull(value.priorCurrent) &&
    releaseOrNull(value.priorPrevious) &&
    SHA256.test(value.preparedTreeSha256) &&
    SHA256.test(value.requestSha256) &&
    SHA256.test(value.checksum) &&
    createHash("sha256").update(JSON.stringify(payload)).digest("hex") ===
      value.checksum
  );
}

async function loadPreparedJournal(operationId) {
  const slots = [];
  for (const name of ["operation-a.json", "operation-b.json"]) {
    try {
      const path = join(JOURNAL_ROOT, name);
      const value = await readJson(path);
      if (validJournal(value, operationId)) {
        const info = await lstat(path);
        slots.push({ name, value, uid: info.uid, gid: info.gid });
      }
    } catch {}
  }
  if (slots.length === 0) fail();
  slots.sort(
    (left, right) =>
      left.value.generation - right.value.generation ||
      left.name.localeCompare(right.name),
  );
  if (
    slots.length === 2 &&
    slots[0].value.generation === slots[1].value.generation &&
    slots[0].value.checksum !== slots[1].value.checksum
  ) {
    fail();
  }
  return slots.at(-1);
}

async function transitionJournal(selected, phase, update = {}) {
  const previous = selected.value;
  const allowed = {
    prepared: ["activating"],
    activating: ["activated", "rolled_back", "rollback_failed"],
    activated: ["healthy", "rolled_back", "rollback_failed"],
    healthy: [],
  };
  if (!allowed[previous.phase]?.includes(phase)) fail();
  const payload = {
    ...journalPayload(previous),
    generation: previous.generation + 1,
    phase,
    preparedTreeSha256:
      update.preparedTreeSha256 ?? previous.preparedTreeSha256,
    diagnostics: update.diagnostics ?? previous.diagnostics,
    updatedAt: update.updatedAt ?? previous.updatedAt,
  };
  const next = {
    ...payload,
    checksum: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
  const targetName =
    selected.name === "operation-a.json"
      ? "operation-b.json"
      : "operation-a.json";
  const target = join(JOURNAL_ROOT, targetName);
  const temporary = join(JOURNAL_ROOT, `.${targetName}.${process.pid}.tmp`);
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
    await handle.chown(selected.uid, selected.gid);
    await handle.writeFile(Buffer.from(JSON.stringify(next), "utf8"));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    renamed = true;
    const directory = await open(
      JOURNAL_ROOT,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return {
      name: targetName,
      value: next,
      uid: selected.uid,
      gid: selected.gid,
    };
  } finally {
    await handle?.close();
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

async function assertRootProjection(operationId, journal) {
  const path = join(PROJECTION_ROOT, `${operationId}.json`);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    (info.mode & 0o022) !== 0
  )
    fail();
  const projection = await readJson(path, 64 * 1024);
  if (
    !exactKeys(projection, [
      "schemaVersion",
      "operationId",
      "generation",
      "checksum",
      "candidate",
      "preparedTreeSha256",
      "policy",
    ]) ||
    projection.schemaVersion !== 1 ||
    projection.operationId !== operationId ||
    projection.generation !== journal.generation ||
    projection.checksum !== journal.checksum ||
    projection.candidate !== journal.candidate ||
    projection.preparedTreeSha256 !== journal.preparedTreeSha256
  ) {
    fail();
  }
  return parseRootPolicy(projection.policy);
}

async function readPointer(name) {
  const path = join(INSTALL_ROOT, name);
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink() || info.uid !== 0) fail();
    const target = await readlink(path);
    const prefix = "releases/";
    const release = target.startsWith(prefix)
      ? target.slice(prefix.length)
      : "";
    if (!RELEASE_NAME.test(release) || target !== `${prefix}${release}`) fail();
    return release;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRecordedLinks(journal) {
  const install = await lstat(INSTALL_ROOT);
  const releases = await lstat(RELEASES_ROOT);
  if (
    !install.isDirectory() ||
    install.isSymbolicLink() ||
    install.uid !== 0 ||
    (install.mode & 0o022) !== 0 ||
    !releases.isDirectory() ||
    releases.isSymbolicLink() ||
    releases.uid !== 0 ||
    (releases.mode & 0o022) !== 0 ||
    (await readPointer("current")) !== journal.priorCurrent ||
    (await readPointer("previous")) !== journal.priorPrevious
  ) {
    fail();
  }
}

async function fsyncDirectory(path) {
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

async function hardenTree(root, ownerUid, ownerGid) {
  async function walk(path) {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      await lchown(path, ownerUid, ownerGid);
      return;
    }
    if (entry.isDirectory()) {
      await chown(path, ownerUid, ownerGid);
      await chmod(path, 0o755);
      const names = await readdir(path);
      names.sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      );
      for (const name of names) {
        if (!name || name === "." || name === ".." || name.includes("/"))
          fail("prepared-tree");
        await walk(join(path, name));
      }
      return;
    }
    if (!entry.isFile()) fail("prepared-tree");
    await chown(path, ownerUid, ownerGid);
    await chmod(path, (entry.mode & 0o111) === 0 ? 0o644 : 0o755);
  }
  await walk(root);
}

async function copyAdoptedTree(sourceRoot, targetRoot, ownerUid, ownerGid) {
  await mkdir(targetRoot, { mode: 0o700 });
  await chown(targetRoot, ownerUid, ownerGid);
  async function copyDirectory(source, target, isRoot = false) {
    if (!isRoot) {
      await mkdir(target, { mode: 0o755 });
      await chown(target, ownerUid, ownerGid);
    }
    const names = await readdir(source);
    names.sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("/"))
        fail("prepared-tree");
      const sourcePath = join(source, name);
      const targetPath = join(target, name);
      const entry = await lstat(sourcePath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await copyDirectory(sourcePath, targetPath);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        const sourceHandle = await open(
          sourcePath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        let targetHandle;
        try {
          const before = await sourceHandle.stat();
          if (!before.isFile()) fail("prepared-tree");
          targetHandle = await open(
            targetPath,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            (before.mode & 0o111) === 0 ? 0o644 : 0o755,
          );
          await targetHandle.chown(ownerUid, ownerGid);
          const buffer = Buffer.allocUnsafe(64 * 1024);
          let offset = 0;
          while (true) {
            const { bytesRead } = await sourceHandle.read(
              buffer,
              0,
              buffer.length,
              offset,
            );
            if (bytesRead === 0) break;
            let written = 0;
            while (written < bytesRead) {
              const result = await targetHandle.write(
                buffer,
                written,
                bytesRead - written,
                offset + written,
              );
              if (result.bytesWritten <= 0) fail("prepared-tree");
              written += result.bytesWritten;
            }
            offset += bytesRead;
          }
          const after = await sourceHandle.stat();
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            offset !== before.size
          )
            fail("prepared-tree");
          await targetHandle.chmod((before.mode & 0o111) === 0 ? 0o644 : 0o755);
          await targetHandle.sync();
        } finally {
          await targetHandle?.close();
          await sourceHandle.close();
        }
      } else if (entry.isSymbolicLink()) {
        await symlink(await readlink(sourcePath), targetPath);
        await lchown(targetPath, ownerUid, ownerGid);
      } else {
        fail("prepared-tree");
      }
    }
    await chmod(target, 0o755);
    await fsyncDirectory(target);
  }
  await copyDirectory(sourceRoot, targetRoot, true);
}

export async function adoptCandidateTree(
  candidate,
  preparedTreeSha256,
  options = {},
) {
  if (!RELEASE_NAME.test(candidate) || !SHA256.test(preparedTreeSha256)) fail();
  const releasesRoot = options.releasesRoot ?? RELEASES_ROOT;
  const ownerUid = options.ownerUid ?? 0;
  const ownerGid = options.ownerGid ?? 0;
  const path = resolve(releasesRoot, candidate);
  if (dirname(path) !== releasesRoot || basename(path) !== candidate) fail();
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
  const suffix = `${process.pid}.${Date.now()}`;
  const quarantine = join(releasesRoot, `.${candidate}.${suffix}.quarantine`);
  const projection = join(releasesRoot, `.${candidate}.${suffix}.projection`);
  let quarantined = false;
  let installed = false;
  try {
    await rename(path, quarantine);
    quarantined = true;
    await fsyncDirectory(releasesRoot);
    await hardenTree(quarantine, ownerUid, ownerGid);
    await copyAdoptedTree(quarantine, projection, ownerUid, ownerGid);
    if ((await digestTree(projection, ownerUid)) !== preparedTreeSha256) fail();
    await rename(projection, path);
    installed = true;
    await fsyncDirectory(releasesRoot);
    if ((await digestTree(path, ownerUid)) !== preparedTreeSha256) fail();
    await rm(quarantine, { recursive: true });
    quarantined = false;
    await fsyncDirectory(releasesRoot);
  } catch (error) {
    await rm(projection, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (installed) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      installed = false;
    }
    if (quarantined) {
      await rename(quarantine, path).catch(() => undefined);
      await fsyncDirectory(releasesRoot).catch(() => undefined);
    }
    throw error;
  }
}

function prefix(value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export async function digestTree(root, expectedUid = 0) {
  const records = [];
  async function walk(directory, relativeDirectory) {
    const names = await readdir(directory);
    names.sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("/"))
        fail("prepared-tree");
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      const path = join(directory, name);
      const entry = await lstat(path);
      if (entry.uid !== expectedUid || (entry.mode & 0o022) !== 0) fail();
      if (
        MARKERS.has(relativePath) &&
        entry.isFile() &&
        !entry.isSymbolicLink()
      )
        continue;
      let entryType;
      let contentIdentity;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        entryType = "directory";
        contentIdentity = "";
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        entryType = "file";
        contentIdentity = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      } else if (entry.isSymbolicLink()) {
        entryType = "symlink";
        contentIdentity = await readlink(path);
      } else fail("prepared-tree");
      records.push({
        relativePath,
        entryType,
        normalizedMode: (entry.mode & 0o7777).toString(8).padStart(4, "0"),
        contentIdentity,
      });
      if (entryType === "directory") await walk(path, relativePath);
    }
  }
  await walk(root, "");
  const hash = createHash("sha256");
  for (const record of records) {
    hash.update(prefix(record.relativePath));
    hash.update(prefix(record.entryType));
    hash.update(prefix(record.normalizedMode));
    hash.update(prefix(record.contentIdentity));
  }
  return hash.digest("hex");
}

async function revalidateCandidate(journal, policy) {
  const path = resolve(RELEASES_ROOT, journal.candidate);
  if (dirname(path) !== RELEASES_ROOT || basename(path) !== journal.candidate)
    fail();
  const entry = await lstat(path);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.uid !== 0 ||
    (entry.mode & 0o022) !== 0
  )
    fail();
  const marker = await readJson(join(path, "artifact-state.json"), 128 * 1024);
  const envelope = await readBytes(
    join(path, "artifact-envelope.json"),
    MAX_JSON_BYTES,
  );
  const envelopeSha = createHash("sha256").update(envelope).digest("hex");
  const expected = journal.expected;
  if (
    !exactKeys(marker, [
      "schemaVersion",
      "artifact",
      "metadata",
      "envelopeSha256",
      "preparedTreeSha256",
      "writtenAt",
    ]) ||
    marker.schemaVersion !== 1 ||
    !SHA256.test(marker.artifact?.sha256) ||
    !SHA256.test(marker.metadata?.payloadSha256) ||
    marker.envelopeSha256 !== envelopeSha ||
    marker.preparedTreeSha256 !== journal.preparedTreeSha256 ||
    !journal.candidate.endsWith(`-${marker.artifact.sha256}`) ||
    (journal.kind === "update" &&
      (expected === null ||
        expected.artifact.sha256 !== marker.artifact.sha256 ||
        expected.metadata.payloadSha256 !== marker.metadata.payloadSha256)) ||
    (await digestTree(path)) !== journal.preparedTreeSha256
  ) {
    fail();
  }
  let knownGood = null;
  if (journal.kind === "rollback") {
    knownGood = await readJson(join(path, "known-good.json"), 64 * 1024);
    if (
      !exactKeys(knownGood, [
        "schemaVersion",
        "operationId",
        "artifactSha256",
        "metadataSha256",
        "preparedTreeSha256",
        "activatedAt",
      ]) ||
      knownGood.schemaVersion !== 1 ||
      !OPERATION_ID.test(knownGood.operationId) ||
      knownGood.artifactSha256 !== marker.artifact.sha256 ||
      knownGood.metadataSha256 !== marker.metadata.payloadSha256 ||
      knownGood.preparedTreeSha256 !== journal.preparedTreeSha256
    ) {
      fail();
    }
  }
  const authorized = await verifyCandidateAuthorization(
    journal,
    marker,
    envelope,
    knownGood,
    { policy },
  );
  return {
    path,
    ...authorized,
  };
}

async function run(command, args, options = {}) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "inherit",
      env: options.env,
      cwd: options.cwd,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 && signal === null
        ? accept()
        : reject(new Error("command failed")),
    );
  });
}

async function capture(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null || size > MAX_JSON_BYTES) {
        reject(new Error("command failed"));
      } else accept(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function atomicLink(name, target) {
  if ((name !== "current" && name !== "previous") || !RELEASE_NAME.test(target))
    fail();
  const destination = join(INSTALL_ROOT, name);
  const temporary = join(INSTALL_ROOT, `.${name}.${process.pid}.tmp`);
  await unlink(temporary).catch(() => undefined);
  await symlink(`releases/${target}`, temporary);
  await rename(temporary, destination);
  const directory = await open(
    INSTALL_ROOT,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function removeLink(name) {
  await unlink(join(INSTALL_ROOT, name)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await fsyncDirectory(INSTALL_ROOT);
}

async function restoreLinks(journal) {
  if (journal.priorCurrent === null) await removeLink("current");
  else await atomicLink("current", journal.priorCurrent);
  if (journal.priorPrevious === null) await removeLink("previous");
  else await atomicLink("previous", journal.priorPrevious);
}

async function pm2(arguments_, environment = {}) {
  return run("/usr/bin/sudo", [
    "-u",
    "homeworker",
    "--",
    "/usr/bin/env",
    "-i",
    ...Object.entries({ ...HOMEWORKER_ENV, ...environment }).map(
      ([key, value]) => `${key}=${value}`,
    ),
    "/usr/bin/pm2",
    ...arguments_,
  ]);
}

async function inspectWorker() {
  const source = await capture("/usr/bin/sudo", [
    "-u",
    "homeworker",
    "--",
    "/usr/bin/env",
    "-i",
    ...Object.entries(HOMEWORKER_ENV).map(([key, value]) => `${key}=${value}`),
    "/usr/bin/pm2",
    "jlist",
  ]);
  const list = JSON.parse(source);
  const matches = list.filter((entry) => entry.name === "worker");
  if (matches.length !== 1) fail("pm2");
  const entry = matches[0];
  const snapshot = {
    pid: entry.pid,
    restartCount: entry.pm2_env?.restart_time,
    status: entry.pm2_env?.status,
    startedAt: entry.pm2_env?.pm_uptime,
  };
  if (
    !Number.isSafeInteger(snapshot.pid) ||
    snapshot.pid <= 0 ||
    !Number.isSafeInteger(snapshot.restartCount) ||
    snapshot.restartCount < 0 ||
    snapshot.status !== "online" ||
    !Number.isSafeInteger(snapshot.startedAt) ||
    snapshot.startedAt <= 0
  ) {
    fail("pm2");
  }
  return snapshot;
}

async function waitForHealth(operationId, candidate, first) {
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    const observed = await inspectWorker();
    if (
      observed.pid !== first.pid ||
      observed.restartCount !== first.restartCount
    ) {
      fail("restart-loop");
    }
    let marker = null;
    try {
      marker = await readJson(READY_PATH, 64 * 1024);
    } catch {}
    if (
      exactKeys(marker, [
        "schemaVersion",
        "operationId",
        "pid",
        "artifactSha256",
        "metadataSha256",
        "writtenAt",
      ]) &&
      marker.schemaVersion === 1 &&
      marker.operationId === operationId &&
      marker.pid === first.pid &&
      marker.artifactSha256 === candidate.artifactSha256 &&
      marker.metadataSha256 === candidate.metadataSha256 &&
      Date.now() - first.startedAt >= 60_000
    ) {
      return;
    }
    await new Promise((accept) => setTimeout(accept, 1_000));
  }
  fail("readiness");
}

async function writeKnownGood(candidate, operationId, preparedTreeSha256) {
  const path = join(candidate.path, "known-good.json");
  const temporary = join(candidate.path, `.known-good.json.${process.pid}.tmp`);
  const marker = {
    schemaVersion: 1,
    operationId,
    artifactSha256: candidate.artifactSha256,
    metadataSha256: candidate.metadataSha256,
    preparedTreeSha256,
    activatedAt: new Date().toISOString(),
  };
  let handle;
  let renamed = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
    await handle.writeFile(Buffer.from(JSON.stringify(marker), "utf8"));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    renamed = true;
    const directory = await open(
      candidate.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return marker;
  } finally {
    await handle?.close();
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

export async function activateOperation(operationIdInput) {
  const operationId = canonicalOperationId(operationIdInput);
  let selected = await loadPreparedJournal(operationId);
  const policy = await assertRootProjection(operationId, selected.value);
  await assertRecordedLinks(selected.value);
  await adoptCandidateTree(
    selected.value.candidate,
    selected.value.preparedTreeSha256,
  );
  const candidate = await revalidateCandidate(selected.value, policy);

  let switched = false;
  let previousCommitted = false;
  try {
    await unlink(READY_PATH).catch(() => undefined);
    await pm2(["stop", "worker"]);
    await pm2(["delete", "worker"]);
    await run(
      "/usr/bin/sudo",
      [
        "-u",
        "homeworker",
        "--",
        "/usr/bin/env",
        "-i",
        ...Object.entries(HOMEWORKER_ENV).map(
          ([key, value]) => `${key}=${value}`,
        ),
        "/usr/bin/node",
        join(candidate.path, "dist/system/infrastructure/migrate.entry.js"),
      ],
      { cwd: candidate.path },
    );
    selected = await transitionJournal(selected, "activating", {
      updatedAt: new Date().toISOString(),
    });
    switched = true;
    await atomicLink("current", selected.value.candidate);
    selected = await transitionJournal(selected, "activated", {
      updatedAt: new Date().toISOString(),
    });
    await pm2(
      [
        "start",
        "/usr/lib/home-worker/ecosystem.config.cjs",
        "--only",
        "worker",
        "--update-env",
      ],
      {
        HOME_WORKER_OTA_OPERATION_ID: operationId,
        HOME_WORKER_OTA_ARTIFACT_SHA256: candidate.artifactSha256,
        HOME_WORKER_OTA_METADATA_SHA256: candidate.metadataSha256,
      },
    );
    const first = await inspectWorker();
    if (first.restartCount !== 0) fail("restart-loop");
    await waitForHealth(operationId, candidate, first);
    const knownGood = await writeKnownGood(
      candidate,
      operationId,
      selected.value.preparedTreeSha256,
    );
    if (selected.value.priorCurrent === null) await removeLink("previous");
    else await atomicLink("previous", selected.value.priorCurrent);
    previousCommitted = true;
    selected = await transitionJournal(selected, "healthy", {
      updatedAt: knownGood.activatedAt,
    });
  } catch (error) {
    if (previousCommitted) fail("maintenance-required");
    try {
      if (switched) await restoreLinks(selected.value);
      await pm2([
        "start",
        "/usr/lib/home-worker/ecosystem.config.cjs",
        "--only",
        "worker",
        "--update-env",
      ]);
    } catch {
      if (
        selected.value.phase === "activating" ||
        selected.value.phase === "activated"
      ) {
        await transitionJournal(selected, "rollback_failed", {
          diagnostics: {
            code: "rollback",
            notes: [],
          },
          updatedAt: new Date().toISOString(),
        }).catch(() => undefined);
      }
      fail("rollback");
    }
    if (
      switched &&
      (selected.value.phase === "activating" ||
        selected.value.phase === "activated")
    ) {
      selected = await transitionJournal(selected, "rolled_back", {
        diagnostics: {
          code: error instanceof ActivationError ? error.code : "activation",
          notes: [],
        },
        updatedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  if (process.argv.length !== 3) process.exit(64);
  activateOperation(process.argv[2]).catch(() => process.exit(75));
}
