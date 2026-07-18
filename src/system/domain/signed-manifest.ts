import { createHash, verify, type KeyObject } from "node:crypto";
import {
  updateTargetName,
  type ArtifactIdentity,
  type CheckedReleaseIdentity,
  type UpdateTargetName,
  type UpdateTarget,
} from "./ota-contracts";
import { compareLibcVersions, parseLibcVersion } from "./libc-version";
import { decodeCanonicalBase64, parseStrictJson } from "./strict-json";

const MAX_ENVELOPE_BYTES = 96 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_PREPARED_BYTES = 1024 * 1024 * 1024;
const MAX_PREPARED_FILES = 200_000;
const MAX_FILES = 20_000;
const MAX_VALIDITY_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ABI = /^(?:0|[1-9]\d*)$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type JsonRecord = Record<string, unknown>;

export const OTA_KEY_SCOPE: unique symbol = Symbol("OTA_KEY_SCOPE");

export interface ActiveKey {
  keyId: string;
  publicKey: KeyObject;
}

export type FeedVerificationKey = ActiveKey & {
  readonly [OTA_KEY_SCOPE]?: "active";
};

export interface ManifestPolicy {
  feedUrl: string;
  channel: "stable";
  target: {
    targetName: UpdateTargetName;
    platform: "linux";
    arch: "arm" | "arm64";
    libc: "glibc";
    libcVersion: string;
    nodeModulesAbi: string;
  };
  runtime: {
    nodeMajor: number;
    packageManager: "yarn@4.13.0";
  };
  limits: {
    maxArtifactBytes: number;
    maxExpandedBytes: number;
    maxPreparedBytes: number;
    maxPreparedFiles: number;
    maxFiles: number;
  };
}

export type ManifestTarget = UpdateTarget;

export interface SignedArtifact {
  url: string;
  format: "tar.gz";
  size: number;
  expandedSize: number;
  maxPreparedSize: number;
  maxPreparedFiles: number;
  fileCount: number;
  sha256: string;
}

export interface SignedManifest {
  schemaVersion: 1;
  metadataVersion: number;
  channel: "stable";
  version: string;
  commit: string;
  publishedAt: string;
  expiresAt: string;
  target: ManifestTarget;
  artifact: SignedArtifact;
  runtime: { nodeMajor: number; packageManager: string };
}

export interface EnvelopeSignature {
  keyId: string;
  signatureBytes: Buffer;
}

export interface ParsedOuterEnvelope {
  payloadBytes: Buffer;
  signatures: EnvelopeSignature[];
}

export interface VerifiedEnvelope {
  outerBytes: Buffer;
  payloadBytes: Buffer;
  payloadSha256: string;
  manifest: SignedManifest;
  matchingActiveKeyIds: string[];
  checkedRelease: CheckedReleaseIdentity;
}

function invalid(message: string): never {
  throw new Error(`invalid signed OTA manifest: ${message}`);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function expectKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    invalid(`${label} has unknown or missing keys`);
  }
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  return value;
}

function asPositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    invalid(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function boundedInteger(
  value: unknown,
  label: string,
  configuredMaximum: number,
  hardMaximum: number,
): number {
  const maximum = asPositiveSafeInteger(
    configuredMaximum,
    `${label} policy maximum`,
  );
  if (maximum > hardMaximum)
    invalid(`${label} policy exceeds its hard ceiling`);
  const parsed = asPositiveSafeInteger(value, label);
  if (parsed > maximum) invalid(`${label} exceeds its configured maximum`);
  return parsed;
}

function asTimestamp(
  value: unknown,
  label: string,
): { text: string; milliseconds: number } {
  const text = asString(value, label);
  const milliseconds = Date.parse(text);
  if (
    !TIMESTAMP.test(text) ||
    Number.isNaN(milliseconds) ||
    new Date(milliseconds).toISOString() !== text
  ) {
    invalid(`${label} must be a canonical UTC timestamp`);
  }
  return { text, milliseconds };
}

function asStableSemver(value: unknown, label: string): string {
  const version = asString(value, label);
  if (version.length > 64 || !STABLE_SEMVER.test(version)) {
    invalid(`${label} must be a stable canonical SemVer release`);
  }
  return version;
}

function asDottedVersion(value: unknown, label: string): string {
  try {
    return parseLibcVersion(asString(value, label));
  } catch {
    invalid(`${label} must be a canonical dotted version`);
  }
}

function publicKeyId(publicKey: KeyObject): string | null {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
    return null;
  try {
    return createHash("sha256")
      .update(publicKey.export({ format: "der", type: "spki" }))
      .digest("hex");
  } catch {
    return null;
  }
}

export function parseOuterEnvelope(bytes: Uint8Array): ParsedOuterEnvelope {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) invalid("envelope exceeds 96 KiB");
  const envelope = asRecord(parseStrictJson(bytes), "envelope");
  expectKeys(envelope, ["payload", "signatures"], "envelope");
  const payloadBytes = decodeCanonicalBase64(
    envelope.payload,
    "envelope.payload",
  );
  if (!Array.isArray(envelope.signatures))
    invalid("envelope.signatures must be an array");
  if (envelope.signatures.length < 1 || envelope.signatures.length > 3) {
    invalid("envelope must contain one to three signatures");
  }
  const keyIds = new Set<string>();
  const signatures = envelope.signatures.map(
    (entry, index): EnvelopeSignature => {
      const signature = asRecord(entry, `envelope.signatures[${index}]`);
      expectKeys(
        signature,
        ["keyId", "signature"],
        `envelope.signatures[${index}]`,
      );
      const keyId = asString(
        signature.keyId,
        `envelope.signatures[${index}].keyId`,
      );
      if (!SHA256.test(keyId))
        invalid(`envelope.signatures[${index}].keyId is malformed`);
      if (keyIds.has(keyId)) invalid("envelope contains duplicate key IDs");
      keyIds.add(keyId);
      const signatureBytes = decodeCanonicalBase64(
        signature.signature,
        `envelope.signatures[${index}].signature`,
      );
      if (signatureBytes.byteLength !== 64)
        invalid("signature must decode to exactly 64 bytes");
      return { keyId, signatureBytes };
    },
  );
  return { payloadBytes, signatures };
}

function parseManifest(
  value: unknown,
  policy: ManifestPolicy,
  checkTime: Date,
): SignedManifest {
  const manifest = asRecord(value, "manifest");
  expectKeys(
    manifest,
    [
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
    ],
    "manifest",
  );
  if (manifest.schemaVersion !== 1) invalid("schemaVersion is unsupported");
  const metadataVersion = asPositiveSafeInteger(
    manifest.metadataVersion,
    "metadataVersion",
  );
  if (policy.channel !== "stable" || manifest.channel !== policy.channel) {
    invalid("channel must match the stable policy");
  }
  const version = asStableSemver(manifest.version, "version");
  const commit = asString(manifest.commit, "commit");
  if (!COMMIT.test(commit))
    invalid("commit must be a lowercase full Git digest");

  const publishedAt = asTimestamp(manifest.publishedAt, "publishedAt");
  const expiresAt = asTimestamp(manifest.expiresAt, "expiresAt");
  const checkMilliseconds = checkTime.getTime();
  if (Number.isNaN(checkMilliseconds)) invalid("check time is invalid");
  if (publishedAt.milliseconds >= expiresAt.milliseconds)
    invalid("metadata validity window is empty");
  if (expiresAt.milliseconds - publishedAt.milliseconds > MAX_VALIDITY_MS) {
    invalid("metadata validity exceeds 31 days");
  }
  if (publishedAt.milliseconds > checkMilliseconds + MAX_FUTURE_SKEW_MS) {
    invalid("publishedAt exceeds allowed clock skew");
  }
  if (expiresAt.milliseconds <= checkMilliseconds)
    invalid("metadata is expired");

  const targetValue = asRecord(manifest.target, "target");
  expectKeys(
    targetValue,
    ["platform", "arch", "libc", "libcMinVersion", "nodeModulesAbi"],
    "target",
  );
  let mappedPolicyTargetName: UpdateTargetName;
  try {
    mappedPolicyTargetName = updateTargetName(policy.target);
  } catch {
    return invalid("policy target mapping is unsupported");
  }
  if (policy.target.targetName !== mappedPolicyTargetName)
    invalid("policy target mapping is inconsistent");
  if (
    targetValue.platform !== "linux" ||
    targetValue.platform !== policy.target.platform ||
    (targetValue.arch !== "arm" && targetValue.arch !== "arm64") ||
    targetValue.arch !== policy.target.arch ||
    targetValue.libc !== "glibc" ||
    targetValue.libc !== policy.target.libc
  ) {
    invalid("target platform is incompatible");
  }
  const libcMinVersion = asDottedVersion(
    targetValue.libcMinVersion,
    "target.libcMinVersion",
  );
  const libcVersion = asDottedVersion(
    policy.target.libcVersion,
    "policy.target.libcVersion",
  );
  if (compareLibcVersions(libcMinVersion, libcVersion) > 0) {
    invalid("target requires a newer libc");
  }
  const nodeModulesAbi = asString(
    targetValue.nodeModulesAbi,
    "target.nodeModulesAbi",
  );
  if (
    !ABI.test(nodeModulesAbi) ||
    nodeModulesAbi !== policy.target.nodeModulesAbi
  ) {
    invalid("target Node modules ABI is incompatible");
  }
  const target: ManifestTarget = {
    platform: "linux",
    arch: targetValue.arch,
    libc: "glibc",
    libcMinVersion,
    nodeModulesAbi,
  };

  const artifactValue = asRecord(manifest.artifact, "artifact");
  expectKeys(
    artifactValue,
    [
      "url",
      "format",
      "size",
      "expandedSize",
      "maxPreparedSize",
      "maxPreparedFiles",
      "fileCount",
      "sha256",
    ],
    "artifact",
  );
  const artifactUrl = asString(artifactValue.url, "artifact.url");
  let parsedArtifactUrl: URL;
  let parsedFeedUrl: URL;
  try {
    parsedArtifactUrl = new URL(artifactUrl);
    parsedFeedUrl = new URL(policy.feedUrl);
  } catch {
    return invalid("artifact and feed URLs must be absolute");
  }
  if (
    parsedFeedUrl.protocol !== "https:" ||
    parsedArtifactUrl.protocol !== "https:" ||
    parsedArtifactUrl.origin !== parsedFeedUrl.origin ||
    parsedArtifactUrl.username !== "" ||
    parsedArtifactUrl.password !== "" ||
    parsedArtifactUrl.hash !== ""
  ) {
    invalid(
      "artifact URL must use the configured HTTPS origin without credentials or fragment",
    );
  }
  if (artifactValue.format !== "tar.gz")
    invalid("artifact.format must be tar.gz");
  const size = boundedInteger(
    artifactValue.size,
    "artifact.size",
    policy.limits.maxArtifactBytes,
    MAX_ARTIFACT_BYTES,
  );
  const expandedSize = boundedInteger(
    artifactValue.expandedSize,
    "artifact.expandedSize",
    policy.limits.maxExpandedBytes,
    MAX_EXPANDED_BYTES,
  );
  const maxPreparedSize = boundedInteger(
    artifactValue.maxPreparedSize,
    "artifact.maxPreparedSize",
    policy.limits.maxPreparedBytes,
    MAX_PREPARED_BYTES,
  );
  const maxPreparedFiles = boundedInteger(
    artifactValue.maxPreparedFiles,
    "artifact.maxPreparedFiles",
    policy.limits.maxPreparedFiles,
    MAX_PREPARED_FILES,
  );
  const fileCount = boundedInteger(
    artifactValue.fileCount,
    "artifact.fileCount",
    policy.limits.maxFiles,
    MAX_FILES,
  );
  if (expandedSize > maxPreparedSize || fileCount > maxPreparedFiles) {
    invalid("artifact declared counts exceed prepared-tree bounds");
  }
  const artifactSha256 = asString(artifactValue.sha256, "artifact.sha256");
  if (!SHA256.test(artifactSha256))
    invalid("artifact.sha256 must be a lowercase digest");

  const runtimeValue = asRecord(manifest.runtime, "runtime");
  expectKeys(runtimeValue, ["nodeMajor", "packageManager"], "runtime");
  const nodeMajor = asPositiveSafeInteger(
    runtimeValue.nodeMajor,
    "runtime.nodeMajor",
  );
  const packageManager = asString(
    runtimeValue.packageManager,
    "runtime.packageManager",
  );
  if (nodeMajor !== policy.runtime.nodeMajor)
    invalid("runtime.nodeMajor is incompatible");
  if (!/^yarn@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageManager)) {
    invalid("runtime.packageManager must be a pinned Yarn release");
  }
  if (packageManager !== policy.runtime.packageManager) {
    invalid("runtime.packageManager is incompatible");
  }

  return {
    schemaVersion: 1,
    metadataVersion,
    channel: "stable",
    version,
    commit,
    publishedAt: publishedAt.text,
    expiresAt: expiresAt.text,
    target,
    artifact: {
      url: artifactUrl,
      format: "tar.gz",
      size,
      expandedSize,
      maxPreparedSize,
      maxPreparedFiles,
      fileCount,
      sha256: artifactSha256,
    },
    runtime: { nodeMajor, packageManager },
  };
}

function checkedRelease(
  manifest: SignedManifest,
  payloadSha256: string,
  targetName: ManifestPolicy["target"]["targetName"],
): CheckedReleaseIdentity {
  const artifact: ArtifactIdentity = {
    version: manifest.version,
    commit: manifest.commit,
    targetName,
    target: {
      platform: manifest.target.platform,
      arch: manifest.target.arch,
      libc: manifest.target.libc,
      libcMinVersion: manifest.target.libcMinVersion,
      nodeModulesAbi: manifest.target.nodeModulesAbi,
    },
    url: manifest.artifact.url,
    format: manifest.artifact.format,
    size: manifest.artifact.size,
    expandedSize: manifest.artifact.expandedSize,
    maxPreparedSize: manifest.artifact.maxPreparedSize,
    maxPreparedFiles: manifest.artifact.maxPreparedFiles,
    fileCount: manifest.artifact.fileCount,
    sha256: manifest.artifact.sha256,
  };
  return {
    artifact,
    metadata: {
      metadataVersion: manifest.metadataVersion,
      channel: manifest.channel,
      payloadSha256,
      publishedAt: manifest.publishedAt,
      expiresAt: manifest.expiresAt,
    },
  };
}

export function verifySignedEnvelope(
  bytes: Uint8Array,
  activeKeys: readonly FeedVerificationKey[],
  policy: ManifestPolicy,
  checkTime: Date,
): VerifiedEnvelope {
  const outerBytes = Buffer.from(bytes);
  const envelope = parseOuterEnvelope(outerBytes);
  if (envelope.payloadBytes.byteLength > MAX_PAYLOAD_BYTES) {
    invalid("decoded payload exceeds 64 KiB");
  }

  const activeById = new Map<string, KeyObject>();
  for (const activeKey of activeKeys) {
    const scope = (activeKey as { readonly [OTA_KEY_SCOPE]?: unknown })[
      OTA_KEY_SCOPE
    ];
    if (scope !== undefined && scope !== "active") continue;
    const derivedId = publicKeyId(activeKey.publicKey);
    if (
      derivedId === null ||
      derivedId !== activeKey.keyId ||
      activeById.has(derivedId)
    )
      continue;
    activeById.set(derivedId, activeKey.publicKey);
  }
  const matchingActiveKeyIds: string[] = [];
  for (const signature of envelope.signatures) {
    const publicKey = activeById.get(signature.keyId);
    if (
      publicKey !== undefined &&
      verify(null, envelope.payloadBytes, publicKey, signature.signatureBytes)
    ) {
      matchingActiveKeyIds.push(signature.keyId);
    }
  }
  if (matchingActiveKeyIds.length === 0)
    invalid("signature is not valid for an active key");

  const payloadSha256 = createHash("sha256")
    .update(envelope.payloadBytes)
    .digest("hex");
  const manifest = parseManifest(
    parseStrictJson(envelope.payloadBytes),
    policy,
    checkTime,
  );
  return {
    outerBytes,
    payloadBytes: envelope.payloadBytes,
    payloadSha256,
    manifest,
    matchingActiveKeyIds,
    checkedRelease: checkedRelease(
      manifest,
      payloadSha256,
      policy.target.targetName,
    ),
  };
}

export type StableReleaseDecision = "downgrade" | "current" | "upgrade";

export function classifyStableRelease(
  installedVersion: string,
  candidateVersion: string,
): StableReleaseDecision {
  const installed = asStableSemver(installedVersion, "installed version")
    .split(".")
    .map(BigInt);
  const candidate = asStableSemver(candidateVersion, "candidate version")
    .split(".")
    .map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] > installed[index]) return "upgrade";
    if (candidate[index] < installed[index]) return "downgrade";
  }
  return "current";
}
