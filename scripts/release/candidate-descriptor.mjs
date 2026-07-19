import { createHash } from "node:crypto";

import { bytewiseCompare } from "./release-policy.mjs";

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 20_000;
const MAX_PREPARED_BYTES = 1024 * 1024 * 1024;
const MAX_PREPARED_FILES = 200_000;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalInventory(records, sourceDateEpoch) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("Invalid archive inventory");
  }
  const seen = new Set();
  const normalized = records.map((record) => {
    const directory = record?.type === "directory";
    const file = record?.type === "file";
    if (
      (!directory && !file) ||
      typeof record.path !== "string" ||
      record.path.length === 0 ||
      seen.has(record.path) ||
      record.uid !== 0 ||
      record.gid !== 0 ||
      record.mtime !== sourceDateEpoch ||
      !Number.isSafeInteger(record.size) ||
      record.size < 0 ||
      (directory &&
        (record.mode !== 0o755 ||
          record.size !== 0 ||
          record.sha256 !== null)) ||
      (file &&
        ((record.mode !== 0o644 && record.mode !== 0o755) ||
          !SHA256.test(record.sha256)))
    ) {
      throw new Error("Invalid archive inventory record");
    }
    seen.add(record.path);
    return {
      path: record.path,
      type: record.type,
      mode: record.mode,
      uid: 0,
      gid: 0,
      mtime: record.mtime,
      size: record.size,
      sha256: record.sha256,
    };
  });
  normalized.sort((left, right) => bytewiseCompare(left.path, right.path));
  return normalized;
}

function inventoryDigest(records) {
  const canonical = records
    .map(
      (record) =>
        `${record.path}\0${record.type}\0${record.mode.toString(8)}\0${record.uid}\0${record.gid}\0${record.mtime}\0${record.size}\0${record.sha256 ?? "-"}\n`,
    )
    .join("");
  return digest(Buffer.from(canonical, "utf8"));
}

export function measureCandidateArchive({
  archiveBytes,
  inventory,
  sourceDateEpoch,
}) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length === 0) {
    throw new Error("Invalid candidate artifact bytes");
  }
  if (archiveBytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error("Candidate artifact size exceeds 100 MiB");
  }
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new Error("Invalid candidate SOURCE_DATE_EPOCH");
  }
  const records = canonicalInventory(inventory, sourceDateEpoch);
  const files = records.filter((record) => record.type === "file");
  const expandedSize = files.reduce((total, record) => total + record.size, 0);
  if (
    !Number.isSafeInteger(expandedSize) ||
    expandedSize > MAX_EXPANDED_BYTES
  ) {
    throw new Error("Candidate expanded size exceeds 512 MiB");
  }
  if (files.length === 0 || records.length > MAX_ARCHIVE_FILES) {
    throw new Error("Candidate file count exceeds archive policy");
  }
  return Object.freeze({
    format: "tar.gz",
    size: archiveBytes.length,
    expandedSize,
    maxPreparedSize: MAX_PREPARED_BYTES,
    maxPreparedFiles: MAX_PREPARED_FILES,
    fileCount: records.length,
    sha256: digest(archiveBytes),
    inventorySha256: inventoryDigest(records),
  });
}

export function encodeCandidateDescriptor({
  version,
  commit,
  sourceDateEpoch,
  builderPolicy,
  cacheInventorySha256,
  archive,
}) {
  if (
    typeof version !== "string" ||
    !VERSION.test(version) ||
    typeof commit !== "string" ||
    !COMMIT.test(commit) ||
    !Number.isSafeInteger(sourceDateEpoch) ||
    sourceDateEpoch < 0 ||
    !SHA256.test(cacheInventorySha256) ||
    builderPolicy?.schemaVersion !== 1 ||
    builderPolicy?.target?.targetName !== "linux-arm64-glibc" ||
    builderPolicy?.runtime?.nodeMajor !== 20 ||
    builderPolicy?.runtime?.packageManager !== "yarn@4.13.0" ||
    archive?.format !== "tar.gz" ||
    !SHA256.test(archive?.sha256) ||
    !SHA256.test(archive?.inventorySha256)
  ) {
    throw new Error("Invalid unsigned candidate descriptor input");
  }
  const descriptor = {
    schemaVersion: 1,
    kind: "home-worker-unsigned-candidate",
    channel: "stable",
    version,
    commit,
    target: { ...builderPolicy.target },
    artifact: { ...archive },
    runtime: { ...builderPolicy.runtime },
    provenance: {
      sourceDateEpoch,
      cacheInventorySha256,
    },
  };
  return Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8");
}
