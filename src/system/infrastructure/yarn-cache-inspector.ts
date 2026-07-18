import { createHash } from "node:crypto";
import {
  close as closeCallback,
  constants,
  createReadStream,
  fstat as fstatCallback,
  open as openCallback,
  type Stats,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { fromFdPromise, type Entry, type ZipFile } from "yauzl";
import type { OtaFailureCode } from "../domain/ota-failure";

const HARD_MAX_PREPARED_BYTES = 1024 * 1024 * 1024;
const HARD_MAX_PREPARED_ENTRIES = 200_000;
const HARD_MAX_PATH_BYTES = 240;

interface CachePolicyFailure extends Error {
  readonly code: Extract<OtaFailureCode, "archive-policy">;
}

export interface YarnCacheInspectionLimits {
  maxEntries: number;
  maxExpandedBytes: number;
}

export interface CacheArchiveRecord {
  path: string;
  size: number;
  sha256: string;
}

export interface CacheInventory {
  archives: CacheArchiveRecord[];
  entryCount: number;
  expandedBytes: number;
}

function policyFailure(): CachePolicyFailure {
  const error = new Error("archive-policy") as CachePolicyFailure;
  error.name = "CachePolicyFailure";
  Object.defineProperty(error, "code", {
    value: "archive-policy",
    enumerable: true,
  });
  return error;
}

function fail(): never {
  throw policyFailure();
}

function assertLimits(limits: YarnCacheInspectionLimits): void {
  if (
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries <= 0 ||
    limits.maxEntries > HARD_MAX_PREPARED_ENTRIES ||
    !Number.isSafeInteger(limits.maxExpandedBytes) ||
    limits.maxExpandedBytes <= 0 ||
    limits.maxExpandedBytes > HARD_MAX_PREPARED_BYTES
  ) {
    fail();
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

function canonicalPath(name: string, allowDirectory: boolean): string {
  const candidate =
    allowDirectory && name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    candidate.length === 0 ||
    candidate.includes("\0") ||
    candidate.includes("\ufffd") ||
    hasControlCharacter(candidate) ||
    Buffer.byteLength(candidate, "utf8") > HARD_MAX_PATH_BYTES ||
    isAbsolute(candidate) ||
    posix.normalize(candidate) !== candidate ||
    candidate === "." ||
    candidate.split("/").some((part) => part.length === 0 || part === "..")
  ) {
    fail();
  }
  return candidate;
}

async function drain(entry: Entry, zipFile: ZipFile): Promise<number> {
  const stream = await zipFile.openReadStreamPromise(entry);
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += Buffer.byteLength(chunk as Uint8Array);
    if (!Number.isSafeInteger(bytes) || bytes > entry.uncompressedSize) fail();
  }
  if (bytes !== entry.uncompressedSize) fail();
  return bytes;
}

function openNoFollow(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    openCallback(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
      (error, fd) => (error ? reject(error) : resolve(fd)),
    );
  });
}

function closeFd(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    closeCallback(fd, (error) => (error ? reject(error) : resolve()));
  });
}

function fstat(fd: number): Promise<Stats> {
  return new Promise((resolve, reject) => {
    fstatCallback(fd, (error, stats) =>
      error ? reject(error) : resolve(stats),
    );
  });
}

async function sha256(fd: number): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream("", { fd, autoClose: false, start: 0 });
  for await (const chunk of stream) hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}

async function inspectZip(
  path: string,
  canonicalName: string,
  limits: YarnCacheInspectionLimits,
  totals: { entryCount: number; expandedBytes: number },
): Promise<CacheArchiveRecord> {
  let fd: number | undefined;
  let zipFile: ZipFile | undefined;
  try {
    fd = await openNoFollow(path);
    const before = await fstat(fd);
    if (!before.isFile() || !Number.isSafeInteger(before.size)) fail();
    const digest = await sha256(fd);
    zipFile = await fromFdPromise(fd, {
      autoClose: false,
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    const seen = new Set<string>();

    for await (const entry of zipFile.eachEntry()) {
      if (
        entry.isEncrypted() ||
        (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) ||
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize < 0
      ) {
        fail();
      }
      const normalized = canonicalPath(entry.fileName, true);
      if (seen.has(normalized)) fail();
      seen.add(normalized);

      totals.entryCount += 1;
      totals.expandedBytes += entry.uncompressedSize;
      if (
        !Number.isSafeInteger(totals.expandedBytes) ||
        totals.entryCount > limits.maxEntries ||
        totals.expandedBytes > limits.maxExpandedBytes
      ) {
        fail();
      }
      await drain(entry, zipFile);
    }

    const after = await fstat(fd);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      fail();
    }
    return { path: canonicalName, size: before.size, sha256: digest };
  } finally {
    if (zipFile !== undefined) {
      zipFile.close();
    } else if (fd !== undefined) {
      await closeFd(fd);
    }
  }
}

export async function inspectYarnCache(
  root: string,
  limits: YarnCacheInspectionLimits,
): Promise<CacheInventory> {
  try {
    assertLimits(limits);
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail();
    const entries = await readdir(root, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    const archives: CacheArchiveRecord[] = [];
    const totals = { entryCount: 0, expandedBytes: 0 };

    for (const entry of entries) {
      const canonicalName = canonicalPath(entry.name, false);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !canonicalName.endsWith(".zip")
      ) {
        fail();
      }
      archives.push(
        await inspectZip(
          join(root, canonicalName),
          canonicalName,
          limits,
          totals,
        ),
      );
    }
    return { archives, ...totals };
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "archive-policy"
    ) {
      throw error;
    }
    throw policyFailure();
  }
}
