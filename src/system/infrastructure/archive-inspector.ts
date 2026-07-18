import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar, { type Headers } from "tar-stream";
import type { OtaFailureCode } from "../domain/ota-failure";

const HARD_MAX_ENTRIES = 20_000;
const HARD_MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 64 * 1024 * 1024;
const HARD_MAX_PATH_BYTES = 240;
const UNSAFE_MODE_BITS = 0o7022;
const OPERATIONAL_SCRIPTS = new Set([
  "scripts/rollback.sh",
  "scripts/system-update.sh",
  "scripts/update.sh",
]);

interface ArchivePolicyFailure extends Error {
  readonly code: Extract<OtaFailureCode, "archive-policy">;
}

interface ParsedTarHeader extends Headers {
  pax?: Record<string, string> | null;
}

export interface ArchiveInspectionLimits {
  maxEntries: number;
  maxExpandedBytes: number;
}

export interface ArchiveExpectation {
  /** Exact count of all regular-file and directory entries in the signed tar. */
  entryCount: number;
  /** Exact sum of the regular-file bodies in the signed tar. */
  regularBytes: number;
}

export interface InspectAndExtractTarGzInput {
  archivePath: string;
  destinationRoot: string;
  expected: ArchiveExpectation;
  limits: ArchiveInspectionLimits;
}

export interface ArchiveInventory {
  entryCount: number;
  regularFileCount: number;
  regularBytes: number;
}

interface ArchiveState extends ArchiveInventory {
  readonly root: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly seen: Set<string>;
  readonly limits: ArchiveInspectionLimits;
}

function policyFailure(): ArchivePolicyFailure {
  const error = new Error("archive-policy") as ArchivePolicyFailure;
  error.name = "ArchivePolicyFailure";
  Object.defineProperty(error, "code", {
    value: "archive-policy",
    enumerable: true,
  });
  return error;
}

function fail(): never {
  throw policyFailure();
}

function assertBoundedInteger(
  value: number,
  maximum: number,
  allowZero = false,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > maximum
  ) {
    fail();
  }
}

function validateInput(input: InspectAndExtractTarGzInput): void {
  assertBoundedInteger(input.limits.maxEntries, HARD_MAX_ENTRIES);
  assertBoundedInteger(input.limits.maxExpandedBytes, HARD_MAX_EXPANDED_BYTES);
  assertBoundedInteger(input.expected.entryCount, input.limits.maxEntries);
  assertBoundedInteger(
    input.expected.regularBytes,
    input.limits.maxExpandedBytes,
    true,
  );
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

function canonicalArchivePath(name: string, maxBytes: number): string {
  if (
    name.length === 0 ||
    name.includes("\0") ||
    name.includes("\ufffd") ||
    hasControlCharacter(name) ||
    Buffer.byteLength(name, "utf8") > maxBytes ||
    isAbsolute(name) ||
    posix.normalize(name) !== name ||
    name === "." ||
    name.split("/").some((part) => part.length === 0 || part === "..")
  ) {
    fail();
  }
  return name;
}

function assertSafeHeader(header: ParsedTarHeader): {
  path: string;
  size: number;
  type: "directory" | "file";
} {
  if (header.type !== "directory" && header.type !== "file") fail();
  if (header.pax !== null && header.pax !== undefined) fail();
  if (header.linkname !== null && header.linkname !== undefined) fail();
  if (
    !Number.isSafeInteger(header.mode) ||
    header.mode === undefined ||
    (header.mode & UNSAFE_MODE_BITS) !== 0
  ) {
    fail();
  }
  if (
    !Number.isSafeInteger(header.size) ||
    header.size === undefined ||
    header.size < 0 ||
    (header.type === "directory" && header.size !== 0)
  ) {
    fail();
  }
  return {
    path: canonicalArchivePath(header.name, HARD_MAX_PATH_BYTES),
    size: header.size,
    type: header.type,
  };
}

async function assertRootIdentity(state: ArchiveState): Promise<void> {
  const current = await lstat(state.root);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== state.rootDevice ||
    current.ino !== state.rootInode
  ) {
    fail();
  }
}

function targetPath(root: string, canonicalPath: string): string {
  const target = resolve(root, ...canonicalPath.split("/"));
  const fromRoot = relative(root, target);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${posix.sep}`) ||
    isAbsolute(fromRoot)
  ) {
    fail();
  }
  return target;
}

async function ensureDirectoryPath(
  state: ArchiveState,
  canonicalPath: string,
): Promise<void> {
  let current = state.root;
  for (const component of canonicalPath.split("/")) {
    await assertRootIdentity(state);
    current = resolve(current, component);
    try {
      const existing = await lstat(current);
      if (existing.isSymbolicLink() || !existing.isDirectory()) fail();
    } catch (error) {
      if (
        error === null ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      await mkdir(current, { mode: 0o755 });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) fail();
    }
    const directory = await open(
      current,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await directory.stat();
      if (!opened.isDirectory()) fail();
      await directory.chmod(0o755);
    } finally {
      await directory.close();
    }
  }
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset);
    if (result.bytesWritten <= 0) fail();
    offset += result.bytesWritten;
  }
}

async function drainEntry(
  stream: NodeJS.ReadableStream,
  write?: (chunk: Buffer) => Promise<void>,
): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (!Number.isSafeInteger(bytes)) fail();
    if (write !== undefined) await write(buffer);
  }
  return bytes;
}

async function processEntry(
  state: ArchiveState,
  header: ParsedTarHeader,
  stream: NodeJS.ReadableStream,
): Promise<void> {
  const parsed = assertSafeHeader(header);
  const canonicalPath = parsed.path;
  if (state.seen.has(canonicalPath)) fail();
  state.seen.add(canonicalPath);

  state.entryCount += 1;
  if (state.entryCount > state.limits.maxEntries) fail();
  const target = targetPath(state.root, canonicalPath);

  if (parsed.type === "directory") {
    if ((await drainEntry(stream)) !== 0) fail();
    await ensureDirectoryPath(state, canonicalPath);
    return;
  }

  if (
    parsed.size > HARD_MAX_FILE_BYTES ||
    state.regularBytes + parsed.size > state.limits.maxExpandedBytes
  ) {
    fail();
  }
  const parent = posix.dirname(canonicalPath);
  if (parent !== ".") await ensureDirectoryPath(state, parent);
  await assertRootIdentity(state);

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const actual = await drainEntry(stream, async (chunk) => {
      await writeAll(handle!, chunk);
    });
    if (actual !== parsed.size) fail();
    await handle.sync();
    await handle.chmod(OPERATIONAL_SCRIPTS.has(canonicalPath) ? 0o755 : 0o644);
  } finally {
    await handle?.close();
  }
  state.regularFileCount += 1;
  state.regularBytes += parsed.size;
}

async function prepareRoot(
  root: string,
  limits: ArchiveInspectionLimits,
): Promise<ArchiveState> {
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (
      error === null ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) fail();
  if ((await readdir(root)).length !== 0) fail();
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let rootDevice = 0;
  let rootInode = 0;
  try {
    const opened = await directory.stat();
    if (!opened.isDirectory()) fail();
    rootDevice = opened.dev;
    rootInode = opened.ino;
    await directory.chmod(0o700);
  } finally {
    await directory.close();
  }
  return {
    root,
    rootDevice,
    rootInode,
    seen: new Set(),
    limits,
    entryCount: 0,
    regularFileCount: 0,
    regularBytes: 0,
  };
}

async function extract(
  input: InspectAndExtractTarGzInput,
  state: ArchiveState,
): Promise<void> {
  const extractor = tar.extract({ filenameEncoding: "utf8" });
  extractor.on("entry", (header, stream, next) => {
    void processEntry(state, header as ParsedTarHeader, stream).then(
      () => next(),
      (error: unknown) => {
        stream.resume();
        next(error);
      },
    );
  });

  const archive = await open(
    input.archivePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    await pipeline(
      archive.createReadStream({ autoClose: false }),
      createGunzip(),
      extractor,
    );
  } finally {
    await archive.close();
  }
}

export async function inspectAndExtractTarGz(
  input: InspectAndExtractTarGzInput,
): Promise<ArchiveInventory> {
  let state: ArchiveState | undefined;
  try {
    validateInput(input);
    state = await prepareRoot(resolve(input.destinationRoot), {
      ...input.limits,
    });
    await extract(input, state);
    if (
      state.entryCount !== input.expected.entryCount ||
      state.regularBytes !== input.expected.regularBytes
    ) {
      fail();
    }
    return {
      entryCount: state.entryCount,
      regularFileCount: state.regularFileCount,
      regularBytes: state.regularBytes,
    };
  } catch (error) {
    if (state !== undefined) {
      await rm(state.root, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
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
