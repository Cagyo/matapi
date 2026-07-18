import { createHash } from "node:crypto";

export const UPDATER_MARKER_PATHS = [
  "artifact-state.json",
  "artifact-envelope.json",
  "known-good.json",
] as const;

export type PreparedTreeEntryType = "directory" | "file" | "symlink";

export interface PreparedTreeRecord {
  relativePath: string;
  entryType: PreparedTreeEntryType;
  normalizedMode: string;
  contentIdentity: string;
}

export interface PreparedTreeMeasurement {
  allocatedBytes: number;
  entryCount: number;
  sha256: string;
}

export interface PreparedTreeGateway {
  measureAndDigest(root: string): Promise<PreparedTreeMeasurement>;
  flushDurably(root: string): Promise<void>;
}

export class PreparedTreeError extends Error {
  readonly code = "prepared-tree" as const;

  constructor(message: string) {
    super(message);
    this.name = "PreparedTreeError";
  }
}

export function normalizePreparedTreeMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

export function isUpdaterMarkerPath(relativePath: string): boolean {
  return (UPDATER_MARKER_PATHS as readonly string[]).includes(relativePath);
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function encodePreparedTreeRecord(record: PreparedTreeRecord): Buffer {
  return Buffer.concat([
    lengthPrefixed(record.relativePath),
    lengthPrefixed(record.entryType),
    lengthPrefixed(record.normalizedMode),
    lengthPrefixed(record.contentIdentity),
  ]);
}

export function canonicalPreparedTreeSha256(
  records: readonly PreparedTreeRecord[],
): string {
  const sorted = [...records].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, "utf8"),
      Buffer.from(right.relativePath, "utf8"),
    ),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].relativePath === sorted[index].relativePath) {
      throw new PreparedTreeError("prepared tree contains a duplicate path");
    }
  }

  const hash = createHash("sha256");
  for (const record of sorted) hash.update(encodePreparedTreeRecord(record));
  return hash.digest("hex");
}
