import { createHash } from "node:crypto";
import {
  isCanonicalVersion,
  isSha256,
  parseReleaseName,
} from "./release-identity";
import {
  isOtaFailureCode,
  type OtaFailure,
  type OtaFailureCode,
} from "./ota-failure";

export type { OtaFailure } from "./ota-failure";

export interface UpdateTarget {
  platform: "linux";
  arch: "arm" | "arm64";
  libc: "glibc";
  libcMinVersion: string;
  nodeModulesAbi: string;
}

export type UpdateTargetName =
  | "linux-arm64-glibc"
  | "linux-armv7-glibc";

export function updateTargetName(
  target: Pick<UpdateTarget, "platform" | "arch" | "libc">,
): UpdateTargetName {
  if (target.platform !== "linux" || target.libc !== "glibc") {
    throw new Error("unsupported OTA update target tuple");
  }
  if (target.arch === "arm64") return "linux-arm64-glibc";
  if (target.arch === "arm") return "linux-armv7-glibc";
  throw new Error("unsupported OTA update target tuple");
}

export interface ArtifactIdentity {
  version: string;
  commit: string;
  targetName: UpdateTargetName;
  target: UpdateTarget;
  url: string;
  format: "tar.gz";
  size: number;
  expandedSize: number;
  maxPreparedSize: number;
  maxPreparedFiles: number;
  fileCount: number;
  sha256: string;
}

export function artifactLedgerIdentitySha256(
  channel: "stable",
  artifact: ArtifactIdentity,
): string {
  const canonicalIdentity = {
    channel,
    targetName: artifact.targetName,
    version: artifact.version,
    commit: artifact.commit,
    target: {
      platform: artifact.target.platform,
      arch: artifact.target.arch,
      libc: artifact.target.libc,
      libcMinVersion: artifact.target.libcMinVersion,
      nodeModulesAbi: artifact.target.nodeModulesAbi,
    },
    url: artifact.url,
    format: artifact.format,
    size: artifact.size,
    expandedSize: artifact.expandedSize,
    maxPreparedSize: artifact.maxPreparedSize,
    maxPreparedFiles: artifact.maxPreparedFiles,
    fileCount: artifact.fileCount,
    sha256: artifact.sha256,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalIdentity), "utf8")
    .digest("hex");
}

export interface MetadataIdentity {
  metadataVersion: number;
  channel: "stable";
  payloadSha256: string;
  publishedAt: string;
  expiresAt: string;
}

export interface CheckedReleaseIdentity {
  artifact: ArtifactIdentity;
  metadata: MetadataIdentity;
}

export type UpdateCheck =
  | {
      kind: "current";
      installed: ArtifactIdentity;
      checked: CheckedReleaseIdentity;
    }
  | {
      kind: "available";
      installed: ArtifactIdentity;
      available: CheckedReleaseIdentity;
    }
  | { kind: "failure"; failure: OtaFailure };

export interface OtaOperationReceipt {
  schemaVersion: 1;
  operationId: string;
  kind: "update" | "rollback";
  acceptedAt: string;
}

export type StartOperationResult =
  | { kind: "started"; receipt: OtaOperationReceipt }
  | { kind: "rejected"; failure: OtaFailure };

export type OperationPhase =
  | "preparing"
  | "prepared"
  | "failed_pre_activation"
  | "activating"
  | "activated"
  | "rolled_back"
  | "rollback_failed"
  | "healthy"
  | "cleanup_pending";

export interface OperationState {
  schemaVersion: 1;
  phase: OperationPhase;
}

export interface HighestMetadata {
  metadataVersion: number;
  payloadSha256: string;
}

export interface TrustedEnvelope {
  bytes: string;
  etag: string;
}

export interface TimeAnchor {
  wallMs: number;
  monotonicMs: number;
  bootId: string;
  persistedAtMs: number;
}

export interface TrustedArtifact {
  channel: "stable";
  targetName: UpdateTargetName;
  version: string;
  artifactIdentitySha256: string;
  artifactSha256: string;
  firstMetadataSha256: string;
}

export interface FailureDay {
  day: string;
  codes: OtaFailureCode[];
}

export interface TrustedState {
  schemaVersion: 1;
  generation: number;
  writtenAt: string;
  highestMetadata: HighestMetadata;
  envelope: TrustedEnvelope;
  timeAnchor: TimeAnchor;
  artifacts: TrustedArtifact[];
  lastNotification: { version: string; artifactSha256: string } | null;
  failureDays: FailureDay[];
  checksum: string;
}

export interface OperationDiagnostics {
  code: OtaFailureCode | null;
  notes: string[];
}

export interface OperationJournal extends OperationState {
  generation: number;
  operationId: string;
  kind: "update" | "rollback";
  expected: CheckedReleaseIdentity | null;
  priorCurrent: string | null;
  priorPrevious: string | null;
  candidate: string | null;
  preparedTreeSha256: string | null;
  diagnostics: OperationDiagnostics;
  updatedAt: string;
  checksum: string;
}

export interface ArtifactMarker {
  schemaVersion: 1;
  artifact: ArtifactIdentity;
  metadata: MetadataIdentity;
  envelopeSha256: string;
  preparedTreeSha256: string;
  writtenAt: string;
}

export interface KnownGoodMarker {
  schemaVersion: 1;
  operationId: string;
  artifactSha256: string;
  metadataSha256: string;
  preparedTreeSha256: string;
  activatedAt: string;
}

export interface ReadinessMarker {
  schemaVersion: 1;
  operationId: string;
  pid: number;
  artifactSha256: string;
  metadataSha256: string;
  writtenAt: string;
}

export interface PreparationReceipt {
  schemaVersion: 1;
  operationId: string;
  candidate: string;
  artifactSha256: string;
  metadataSha256: string;
  inventorySha256: string;
}

export interface StartupReport {
  schemaVersion: 1;
  operationId: string;
  kind: "update" | "rollback";
  outcome: "updated" | "rolled-back" | "failed" | "maintenance-required";
  artifactSha256: string;
  metadataSha256: string;
  failure: OtaFailure | null;
  writtenAt: string;
}

const SCHEMA_VERSION = 1 as const;
const MAX_TRUSTED_STATE_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACTS = 1024;
const MAX_FAILURE_DAYS = 31;
const MAX_DIAGNOSTIC_NOTES = 16;
const MAX_DIAGNOSTIC_NOTE_BYTES = 160;
const OPERATION_ID = /^[A-Za-z0-9_-]{22}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ASCII = /^[\x20-\x7e]*$/;

type JsonRecord = Record<string, unknown>;
type DocumentInput = unknown;

function invalid(message: string): never {
  throw new Error(`invalid OTA schema-v1 document: ${message}`);
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function asDocument(value: DocumentInput): JsonRecord {
  const document =
    typeof value === "string" || value instanceof Uint8Array
      ? parseStrictJson(value)
      : value;
  return asRecord(document, "document");
}

function expectFixedKeys(
  value: JsonRecord,
  keys: readonly string[],
  label: string,
  ordered = false,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    invalid(`${label} has unknown, duplicate, or missing keys`);
  }
  if (ordered && actual.some((key, index) => key !== keys[index])) {
    invalid(`${label} keys are not in canonical order`);
  }
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
  return value;
}

function asSafeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(`${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function asSha256(value: unknown, label: string): string {
  if (!isSha256(value)) invalid(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function asTimestamp(value: unknown, label: string): string {
  const timestamp = asString(value, label);
  if (
    !TIMESTAMP.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    invalid(`${label} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

function asOperationId(value: unknown, label: string): string {
  const operationId = asString(value, label);
  if (
    !OPERATION_ID.test(operationId) ||
    Buffer.from(operationId, "base64url").byteLength !== 16 ||
    Buffer.from(operationId, "base64url").toString("base64url") !== operationId
  )
    invalid(`${label} must be a 22-character base64url ID`);
  return operationId;
}

function asSchemaVersion(value: unknown): 1 {
  if (value !== SCHEMA_VERSION) invalid("schemaVersion is unsupported");
  return SCHEMA_VERSION;
}

function asReleaseName(value: unknown, label: string): string {
  try {
    parseReleaseName(value);
  } catch {
    invalid(`${label} must be a canonical release name`);
  }
  return value as string;
}

function asNullableReleaseName(value: unknown, label: string): string | null {
  return value === null ? null : asReleaseName(value, label);
}

function asNullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : asSha256(value, label);
}

function asKind(value: unknown, label: string): "update" | "rollback" {
  if (value !== "update" && value !== "rollback")
    invalid(`${label} must be update or rollback`);
  return value;
}

function parseTarget(value: unknown, ordered = false): UpdateTarget {
  const target = asRecord(value, "target");
  expectFixedKeys(
    target,
    ["platform", "arch", "libc", "libcMinVersion", "nodeModulesAbi"],
    "target",
    ordered,
  );
  if (target.platform !== "linux") invalid("target.platform must be linux");
  if (target.arch !== "arm" && target.arch !== "arm64")
    invalid("target.arch is unsupported");
  if (target.libc !== "glibc") invalid("target.libc must be glibc");
  const libcMinVersion = asString(
    target.libcMinVersion,
    "target.libcMinVersion",
  );
  const nodeModulesAbi = asString(
    target.nodeModulesAbi,
    "target.nodeModulesAbi",
  );
  if (
    !/^\d+(?:\.\d+)+$/.test(libcMinVersion) ||
    !/^\d+$/.test(nodeModulesAbi)
  ) {
    invalid("target runtime versions are malformed");
  }
  return {
    platform: "linux",
    arch: target.arch,
    libc: "glibc",
    libcMinVersion,
    nodeModulesAbi,
  };
}

export function parseArtifactIdentity(
  value: unknown,
  ordered = false,
): ArtifactIdentity {
  const artifact = asRecord(value, "artifact");
  expectFixedKeys(
    artifact,
    [
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
    ],
    "artifact",
    ordered,
  );
  const version = asString(artifact.version, "artifact.version");
  if (!isCanonicalVersion(version))
    invalid("artifact.version is not canonical semver");
  const commit = asString(artifact.commit, "artifact.commit");
  const targetName = asString(artifact.targetName, "artifact.targetName");
  const target = parseTarget(artifact.target, ordered);
  const expectedTargetName = updateTargetName(target);
  const url = asString(artifact.url, "artifact.url");
  if (targetName !== expectedTargetName)
    invalid("artifact.targetName does not match target tuple");
  if (
    commit.length === 0 ||
    url.length === 0 ||
    artifact.format !== "tar.gz"
  ) {
    invalid("artifact contains an invalid required value");
  }
  return {
    version,
    commit,
    targetName: expectedTargetName,
    target,
    url,
    format: "tar.gz",
    size: asSafeInteger(artifact.size, "artifact.size", 1),
    expandedSize: asSafeInteger(
      artifact.expandedSize,
      "artifact.expandedSize",
      1,
    ),
    maxPreparedSize: asSafeInteger(
      artifact.maxPreparedSize,
      "artifact.maxPreparedSize",
      1,
    ),
    maxPreparedFiles: asSafeInteger(
      artifact.maxPreparedFiles,
      "artifact.maxPreparedFiles",
      1,
    ),
    fileCount: asSafeInteger(artifact.fileCount, "artifact.fileCount", 1),
    sha256: asSha256(artifact.sha256, "artifact.sha256"),
  };
}

export function parseMetadataIdentity(
  value: unknown,
  ordered = false,
): MetadataIdentity {
  const metadata = asRecord(value, "metadata");
  expectFixedKeys(
    metadata,
    ["metadataVersion", "channel", "payloadSha256", "publishedAt", "expiresAt"],
    "metadata",
    ordered,
  );
  if (metadata.channel !== "stable") invalid("metadata.channel must be stable");
  return {
    metadataVersion: asSafeInteger(
      metadata.metadataVersion,
      "metadata.metadataVersion",
      1,
    ),
    channel: "stable",
    payloadSha256: asSha256(metadata.payloadSha256, "metadata.payloadSha256"),
    publishedAt: asTimestamp(metadata.publishedAt, "metadata.publishedAt"),
    expiresAt: asTimestamp(metadata.expiresAt, "metadata.expiresAt"),
  };
}

export function parseCheckedReleaseIdentity(
  value: unknown,
  ordered = false,
): CheckedReleaseIdentity {
  const checked = asRecord(value, "checked release");
  expectFixedKeys(
    checked,
    ["artifact", "metadata"],
    "checked release",
    ordered,
  );
  return {
    artifact: parseArtifactIdentity(checked.artifact, ordered),
    metadata: parseMetadataIdentity(checked.metadata, ordered),
  };
}

export function parseOtaFailure(value: unknown): OtaFailure {
  const failure = asRecord(value, "failure");
  expectFixedKeys(failure, ["code"], "failure");
  if (!isOtaFailureCode(failure.code)) invalid("failure.code is unsupported");
  return { code: failure.code } as OtaFailure;
}

export function parseOperationState(value: unknown): OperationState {
  const state = asRecord(value, "operation state");
  expectFixedKeys(state, ["schemaVersion", "phase"], "operation state");
  const phase = state.phase;
  if (
    ![
      "preparing",
      "prepared",
      "failed_pre_activation",
      "activating",
      "activated",
      "rolled_back",
      "rollback_failed",
      "healthy",
      "cleanup_pending",
    ].includes(phase as string)
  )
    invalid("operation phase is unsupported");
  return {
    schemaVersion: asSchemaVersion(state.schemaVersion),
    phase: phase as OperationPhase,
  };
}

const TRANSITIONS: Readonly<Record<OperationPhase, readonly OperationPhase[]>> =
  {
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

export function canTransitionOperationState(
  from: OperationPhase,
  to: OperationPhase,
): boolean {
  return TRANSITIONS[from].includes(to);
}

function parseHighestMetadata(value: unknown): HighestMetadata {
  const highest = asRecord(value, "highestMetadata");
  expectFixedKeys(
    highest,
    ["metadataVersion", "payloadSha256"],
    "highestMetadata",
    true,
  );
  return {
    metadataVersion: asSafeInteger(
      highest.metadataVersion,
      "highestMetadata.metadataVersion",
      1,
    ),
    payloadSha256: asSha256(
      highest.payloadSha256,
      "highestMetadata.payloadSha256",
    ),
  };
}

function parseEnvelope(value: unknown): TrustedEnvelope {
  const envelope = asRecord(value, "envelope");
  expectFixedKeys(envelope, ["bytes", "etag"], "envelope", true);
  const bytes = asCanonicalBase64(envelope.bytes, "envelope.bytes");
  const etag = asString(envelope.etag, "envelope.etag");
  if (etag.length === 0) invalid("envelope.etag cannot be empty");
  return { bytes, etag };
}

function asCanonicalBase64(value: unknown, label: string): string {
  const encoded = asString(value, label);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    ) ||
    encoded.length === 0 ||
    Buffer.from(encoded, "base64").toString("base64") !== encoded
  ) {
    invalid(`${label} must be canonical padded RFC 4648 Base64`);
  }
  return encoded;
}

function parseTimeAnchor(value: unknown): TimeAnchor {
  const anchor = asRecord(value, "timeAnchor");
  expectFixedKeys(
    anchor,
    ["wallMs", "monotonicMs", "bootId", "persistedAtMs"],
    "timeAnchor",
    true,
  );
  const bootId = asString(anchor.bootId, "timeAnchor.bootId");
  if (bootId.length === 0) invalid("timeAnchor.bootId cannot be empty");
  return {
    wallMs: asSafeInteger(anchor.wallMs, "timeAnchor.wallMs"),
    monotonicMs: asSafeInteger(anchor.monotonicMs, "timeAnchor.monotonicMs"),
    bootId,
    persistedAtMs: asSafeInteger(
      anchor.persistedAtMs,
      "timeAnchor.persistedAtMs",
    ),
  };
}

function parseTrustedArtifact(value: unknown): TrustedArtifact {
  const artifact = asRecord(value, "trusted artifact");
  expectFixedKeys(
    artifact,
    [
      "channel",
      "targetName",
      "version",
      "artifactIdentitySha256",
      "artifactSha256",
      "firstMetadataSha256",
    ],
    "trusted artifact",
    true,
  );
  if (artifact.channel !== "stable")
    invalid("trusted artifact.channel must be stable");
  const targetName = asString(
    artifact.targetName,
    "trusted artifact.targetName",
  );
  if (
    targetName !== "linux-arm64-glibc" &&
    targetName !== "linux-armv7-glibc"
  ) {
    invalid("trusted artifact.targetName is unsupported");
  }
  const version = asString(artifact.version, "trusted artifact.version");
  if (!isCanonicalVersion(version))
    invalid("trusted artifact.version is not canonical semver");
  return {
    channel: "stable",
    targetName,
    version,
    artifactIdentitySha256: asSha256(
      artifact.artifactIdentitySha256,
      "trusted artifact.artifactIdentitySha256",
    ),
    artifactSha256: asSha256(
      artifact.artifactSha256,
      "trusted artifact.artifactSha256",
    ),
    firstMetadataSha256: asSha256(
      artifact.firstMetadataSha256,
      "trusted artifact.firstMetadataSha256",
    ),
  };
}

function parseFailureDays(value: unknown, ordered = false): FailureDay[] {
  if (!Array.isArray(value) || value.length > MAX_FAILURE_DAYS)
    invalid("failureDays is too large");
  return value.map((entry, index) => {
    const day = asRecord(entry, `failureDays[${index}]`);
    expectFixedKeys(day, ["day", "codes"], `failureDays[${index}]`, ordered);
    const dayValue = asString(day.day, `failureDays[${index}].day`);
    const dayTimestamp = `${dayValue}T00:00:00.000Z`;
    if (
      !DAY.test(dayValue) ||
      Number.isNaN(Date.parse(dayTimestamp)) ||
      new Date(dayTimestamp).toISOString().slice(0, 10) !== dayValue
    ) {
      invalid(`failureDays[${index}].day is malformed`);
    }
    if (!Array.isArray(day.codes) || !day.codes.every(isOtaFailureCode))
      invalid(`failureDays[${index}].codes is malformed`);
    return { day: dayValue, codes: [...day.codes] };
  });
}

function checksum(keys: readonly string[], document: JsonRecord): string {
  const payload: JsonRecord = {};
  for (const key of keys) payload[key] = document[key];
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function verifyChecksum(
  document: JsonRecord,
  payloadKeys: readonly string[],
  label: string,
): string {
  const supplied = asSha256(document.checksum, `${label}.checksum`);
  if (checksum(payloadKeys, document) !== supplied)
    invalid(`${label}.checksum does not match canonical payload`);
  return supplied;
}

const TRUSTED_STATE_KEYS = [
  "schemaVersion",
  "generation",
  "writtenAt",
  "highestMetadata",
  "envelope",
  "timeAnchor",
  "artifacts",
  "lastNotification",
  "failureDays",
  "checksum",
] as const;

export function parseTrustedState(value: DocumentInput): TrustedState {
  const state = asDocument(value);
  const serializedBytes =
    typeof value === "string"
      ? Buffer.byteLength(value, "utf8")
      : value instanceof Uint8Array
        ? value.byteLength
        : Buffer.byteLength(JSON.stringify(state), "utf8");
  if (serializedBytes > MAX_TRUSTED_STATE_BYTES)
    invalid("trusted state exceeds 2 MiB");
  expectFixedKeys(state, TRUSTED_STATE_KEYS, "trusted state", true);
  if (!Array.isArray(state.artifacts) || state.artifacts.length > MAX_ARTIFACTS)
    invalid("artifacts is too large");
  const lastNotification =
    state.lastNotification === null
      ? null
      : (() => {
          const notification = asRecord(
            state.lastNotification,
            "lastNotification",
          );
          expectFixedKeys(
            notification,
            ["version", "artifactSha256"],
            "lastNotification",
            true,
          );
          const version = asString(
            notification.version,
            "lastNotification.version",
          );
          if (!isCanonicalVersion(version))
            invalid("lastNotification.version is not canonical semver");
          return {
            version,
            artifactSha256: asSha256(
              notification.artifactSha256,
              "lastNotification.artifactSha256",
            ),
          };
        })();
  const result: TrustedState = {
    schemaVersion: asSchemaVersion(state.schemaVersion),
    generation: asSafeInteger(state.generation, "generation", 1),
    writtenAt: asTimestamp(state.writtenAt, "writtenAt"),
    highestMetadata: parseHighestMetadata(state.highestMetadata),
    envelope: parseEnvelope(state.envelope),
    timeAnchor: parseTimeAnchor(state.timeAnchor),
    artifacts: state.artifacts.map(parseTrustedArtifact),
    lastNotification,
    failureDays: parseFailureDays(state.failureDays, true),
    checksum: verifyChecksum(
      state,
      TRUSTED_STATE_KEYS.slice(0, -1),
      "trusted state",
    ),
  };
  return result;
}

function parseDiagnostics(
  value: unknown,
  ordered = false,
): OperationDiagnostics {
  const diagnostics = asRecord(value, "diagnostics");
  expectFixedKeys(diagnostics, ["code", "notes"], "diagnostics", ordered);
  if (diagnostics.code !== null && !isOtaFailureCode(diagnostics.code))
    invalid("diagnostics.code is unsupported");
  if (
    !Array.isArray(diagnostics.notes) ||
    diagnostics.notes.length > MAX_DIAGNOSTIC_NOTES
  )
    invalid("diagnostics.notes is too large");
  const notes = diagnostics.notes.map((note, index) => {
    const value = asString(note, `diagnostics.notes[${index}]`);
    if (
      !ASCII.test(value) ||
      Buffer.byteLength(value, "utf8") > MAX_DIAGNOSTIC_NOTE_BYTES
    ) {
      invalid(`diagnostics.notes[${index}] is not bounded ASCII`);
    }
    return value;
  });
  return { code: diagnostics.code, notes };
}

const OPERATION_JOURNAL_KEYS = [
  "schemaVersion",
  "generation",
  "operationId",
  "kind",
  "phase",
  "expected",
  "priorCurrent",
  "priorPrevious",
  "candidate",
  "preparedTreeSha256",
  "diagnostics",
  "updatedAt",
  "checksum",
] as const;

export function parseOperationJournal(value: DocumentInput): OperationJournal {
  const journal = asDocument(value);
  expectFixedKeys(journal, OPERATION_JOURNAL_KEYS, "operation journal", true);
  const state = parseOperationState({
    schemaVersion: journal.schemaVersion,
    phase: journal.phase,
  });
  return {
    ...state,
    generation: asSafeInteger(journal.generation, "generation", 1),
    operationId: asOperationId(journal.operationId, "operationId"),
    kind: asKind(journal.kind, "kind"),
    expected:
      journal.expected === null
        ? null
        : parseCheckedReleaseIdentity(journal.expected, true),
    priorCurrent: asNullableReleaseName(journal.priorCurrent, "priorCurrent"),
    priorPrevious: asNullableReleaseName(
      journal.priorPrevious,
      "priorPrevious",
    ),
    candidate: asNullableReleaseName(journal.candidate, "candidate"),
    preparedTreeSha256: asNullableSha256(
      journal.preparedTreeSha256,
      "preparedTreeSha256",
    ),
    diagnostics: parseDiagnostics(journal.diagnostics, true),
    updatedAt: asTimestamp(journal.updatedAt, "updatedAt"),
    checksum: verifyChecksum(
      journal,
      OPERATION_JOURNAL_KEYS.slice(0, -1),
      "operation journal",
    ),
  };
}

/** Returns whether generation updates preserve the fields immutable after generation one. */
export function preservesOperationImmutables(
  previous: OperationJournal,
  next: OperationJournal,
): boolean {
  if (next.generation <= 1) return true;
  return (
    previous.operationId === next.operationId &&
    previous.kind === next.kind &&
    JSON.stringify(previous.expected) === JSON.stringify(next.expected) &&
    previous.priorCurrent === next.priorCurrent &&
    previous.priorPrevious === next.priorPrevious &&
    previous.candidate === next.candidate
  );
}

export function parseArtifactMarker(value: DocumentInput): ArtifactMarker {
  const marker = asDocument(value);
  expectFixedKeys(
    marker,
    [
      "schemaVersion",
      "artifact",
      "metadata",
      "envelopeSha256",
      "preparedTreeSha256",
      "writtenAt",
    ],
    "artifact marker",
  );
  return {
    schemaVersion: asSchemaVersion(marker.schemaVersion),
    artifact: parseArtifactIdentity(marker.artifact),
    metadata: parseMetadataIdentity(marker.metadata),
    envelopeSha256: asSha256(marker.envelopeSha256, "envelopeSha256"),
    preparedTreeSha256: asSha256(
      marker.preparedTreeSha256,
      "preparedTreeSha256",
    ),
    writtenAt: asTimestamp(marker.writtenAt, "writtenAt"),
  };
}

export function parseKnownGoodMarker(value: DocumentInput): KnownGoodMarker {
  const marker = asDocument(value);
  expectFixedKeys(
    marker,
    [
      "schemaVersion",
      "operationId",
      "artifactSha256",
      "metadataSha256",
      "preparedTreeSha256",
      "activatedAt",
    ],
    "known-good marker",
  );
  return {
    schemaVersion: asSchemaVersion(marker.schemaVersion),
    operationId: asOperationId(marker.operationId, "operationId"),
    artifactSha256: asSha256(marker.artifactSha256, "artifactSha256"),
    metadataSha256: asSha256(marker.metadataSha256, "metadataSha256"),
    preparedTreeSha256: asSha256(
      marker.preparedTreeSha256,
      "preparedTreeSha256",
    ),
    activatedAt: asTimestamp(marker.activatedAt, "activatedAt"),
  };
}

export function parseReadinessMarker(value: DocumentInput): ReadinessMarker {
  const marker = asDocument(value);
  expectFixedKeys(
    marker,
    [
      "schemaVersion",
      "operationId",
      "pid",
      "artifactSha256",
      "metadataSha256",
      "writtenAt",
    ],
    "readiness marker",
  );
  return {
    schemaVersion: asSchemaVersion(marker.schemaVersion),
    operationId: asOperationId(marker.operationId, "operationId"),
    pid: asSafeInteger(marker.pid, "pid", 1),
    artifactSha256: asSha256(marker.artifactSha256, "artifactSha256"),
    metadataSha256: asSha256(marker.metadataSha256, "metadataSha256"),
    writtenAt: asTimestamp(marker.writtenAt, "writtenAt"),
  };
}

export function parsePreparationReceipt(
  value: DocumentInput,
): PreparationReceipt {
  const receipt = asDocument(value);
  expectFixedKeys(
    receipt,
    [
      "schemaVersion",
      "operationId",
      "candidate",
      "artifactSha256",
      "metadataSha256",
      "inventorySha256",
    ],
    "preparation receipt",
  );
  return {
    schemaVersion: asSchemaVersion(receipt.schemaVersion),
    operationId: asOperationId(receipt.operationId, "operationId"),
    candidate: asReleaseName(receipt.candidate, "candidate"),
    artifactSha256: asSha256(receipt.artifactSha256, "artifactSha256"),
    metadataSha256: asSha256(receipt.metadataSha256, "metadataSha256"),
    inventorySha256: asSha256(receipt.inventorySha256, "inventorySha256"),
  };
}

export function parseStartupReport(value: DocumentInput): StartupReport {
  const report = asDocument(value);
  expectFixedKeys(
    report,
    [
      "schemaVersion",
      "operationId",
      "kind",
      "outcome",
      "artifactSha256",
      "metadataSha256",
      "failure",
      "writtenAt",
    ],
    "startup report",
  );
  const outcome = report.outcome;
  if (
    !["updated", "rolled-back", "failed", "maintenance-required"].includes(
      outcome as string,
    )
  ) {
    invalid("startup outcome is unsupported");
  }
  return {
    schemaVersion: asSchemaVersion(report.schemaVersion),
    operationId: asOperationId(report.operationId, "operationId"),
    kind: asKind(report.kind, "kind"),
    outcome: outcome as StartupReport["outcome"],
    artifactSha256: asSha256(report.artifactSha256, "artifactSha256"),
    metadataSha256: asSha256(report.metadataSha256, "metadataSha256"),
    failure: report.failure === null ? null : parseOtaFailure(report.failure),
    writtenAt: asTimestamp(report.writtenAt, "writtenAt"),
  };
}

/** Parses strict JSON and rejects BOMs and duplicate object keys before JSON.parse. */
export function parseStrictJson(input: string | Uint8Array): unknown {
  const source =
    typeof input === "string"
      ? input
      : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          input,
        );
  if (source.startsWith("\uFEFF")) invalid("JSON must not contain a BOM");
  assertNoDuplicateJsonKeys(source);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    invalid("JSON is malformed");
  }
}

function assertNoDuplicateJsonKeys(source: string): void {
  let index = 0;
  let depth = 0;
  const maxDepth = 64;
  const whitespace = /[\t\n\r ]/;
  const skipWhitespace = (): void => {
    while (whitespace.test(source[index] ?? "")) index += 1;
  };
  const readString = (): string => {
    const start = index;
    if (source[index] !== '"') invalid("JSON is malformed");
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index)) as string;
        } catch {
          invalid("JSON string is malformed");
        }
      }
      index += 1;
    }
    invalid("JSON string is unterminated");
  };
  const readValue = (): void => {
    skipWhitespace();
    const character = source[index];
    if (character === "{") {
      if (depth >= maxDepth) invalid("JSON nesting exceeds the depth limit");
      depth += 1;
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        depth -= 1;
        return;
      }
      while (true) {
        skipWhitespace();
        const key = readString();
        if (keys.has(key)) invalid("JSON contains duplicate object keys");
        keys.add(key);
        skipWhitespace();
        if (source[index] !== ":") invalid("JSON object is malformed");
        index += 1;
        readValue();
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          depth -= 1;
          return;
        }
        if (source[index] !== ",") invalid("JSON object is malformed");
        index += 1;
      }
    }
    if (character === "[") {
      if (depth >= maxDepth) invalid("JSON nesting exceeds the depth limit");
      depth += 1;
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        depth -= 1;
        return;
      }
      while (true) {
        readValue();
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          depth -= 1;
          return;
        }
        if (source[index] !== ",") invalid("JSON array is malformed");
        index += 1;
      }
    }
    if (character === '"') {
      readString();
      return;
    }
    const primitive =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        source.slice(index),
      )?.[0];
    if (!primitive) invalid("JSON is malformed");
    const numeric = Number(primitive);
    if (
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(primitive) &&
      (!Number.isFinite(numeric) ||
        (Number.isInteger(numeric) && !Number.isSafeInteger(numeric)))
    ) {
      invalid("JSON contains an unsafe integer literal");
    }
    index += primitive.length;
  };
  readValue();
  skipWhitespace();
  if (index !== source.length) invalid("JSON has trailing content");
}
