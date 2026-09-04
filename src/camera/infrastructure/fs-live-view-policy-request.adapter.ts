import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  createLiveViewPolicyRequestV1,
  type LiveViewPolicyRequestV1,
} from "../domain/live-view-policy";
import type { LiveViewPolicyRequestPort } from "../domain/ports/live-view-policy-request.port";
import { assertNoDuplicateJsonKeys } from "./fs-live-view-settings.adapter";

const DEFAULT_REQUEST_DIRECTORY =
  "/var/lib/home-worker/live-view-settings-requests";
const DEFAULT_MAXIMUM_BYTES = 4_096;
const REQUEST_DIRECTORY_MODE = 0o770;
const REQUEST_FILE_MODE = 0o600;
const ROOT_UID = 0;
const REQUEST_ID = /^[A-Za-z0-9_-]{16}$/u;
const TEMPORARY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const O_CLOEXEC = closeOnExecFlagFor(process.platform);

export interface LiveViewPolicySpoolFileHandle {
  stat(): Promise<Stats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface LiveViewPolicySpoolFilesystem {
  open(
    path: string,
    flags: number,
    mode?: number,
  ): Promise<LiveViewPolicySpoolFileHandle>;
  link(source: string, target: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

export const DEFAULT_LIVE_VIEW_POLICY_SPOOL_FILESYSTEM: LiveViewPolicySpoolFilesystem =
  {
    open: async (path, flags, mode) => open(path, flags, mode),
    link,
    unlink,
    readdir,
  };

export interface FsLiveViewPolicyRequestOptions {
  readonly directory?: string;
  readonly expectedDirectoryUid?: number;
  readonly expectedDirectoryGid?: number;
  readonly expectedFileUid?: number;
  readonly expectedFileGid?: number;
  readonly maximumBytes?: number;
  readonly filesystem?: LiveViewPolicySpoolFilesystem;
  readonly temporaryId?: () => string;
}

export interface SafeSpoolDirectoryOptions {
  readonly directory: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
  readonly expectedMode: number;
  readonly filesystem: LiveViewPolicySpoolFilesystem;
}

export interface SafeSpoolEntryOptions<T> {
  readonly path: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
  readonly expectedMode: number;
  readonly minimumBytes: number;
  readonly maximumBytes: number;
  readonly parse: (raw: string) => T;
  readonly filesystem: LiveViewPolicySpoolFilesystem;
}

interface PublishNoReplaceOptions<T> {
  readonly directory: SafeSpoolDirectoryOptions;
  readonly targetName: string;
  readonly body: string;
  readonly expectedFileUid: number;
  readonly expectedFileGid: number;
  readonly expectedFileMode: number;
  readonly minimumBytes: number;
  readonly maximumBytes: number;
  readonly parseExisting: (raw: string) => T;
  readonly isSame: (existing: T) => boolean;
  readonly conflictMessage: string;
  readonly temporaryId: () => string;
}

export class FsLiveViewPolicyRequestAdapter implements LiveViewPolicyRequestPort {
  readonly #directory: SafeSpoolDirectoryOptions;
  readonly #expectedFileUid: number;
  readonly #expectedFileGid: number;
  readonly #maximumBytes: number;
  readonly #temporaryId: () => string;

  constructor(options: FsLiveViewPolicyRequestOptions = {}) {
    this.#directory = {
      directory: options.directory ?? DEFAULT_REQUEST_DIRECTORY,
      expectedUid: options.expectedDirectoryUid ?? ROOT_UID,
      expectedGid: options.expectedDirectoryGid ?? process.getgid?.() ?? -1,
      expectedMode: REQUEST_DIRECTORY_MODE,
      filesystem:
        options.filesystem ?? DEFAULT_LIVE_VIEW_POLICY_SPOOL_FILESYSTEM,
    };
    this.#expectedFileUid = options.expectedFileUid ?? process.getuid?.() ?? -1;
    this.#expectedFileGid = options.expectedFileGid ?? process.getgid?.() ?? -1;
    this.#maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
    this.#temporaryId = options.temporaryId ?? randomUUID;
  }

  async publish(
    request: LiveViewPolicyRequestV1,
  ): Promise<"published" | "already-published"> {
    const canonical = createLiveViewPolicyRequestV1(request);
    const body = serializeRequest(canonical);
    return publishNoReplace({
      directory: this.#directory,
      targetName: `${canonical.requestId}.json`,
      body,
      expectedFileUid: this.#expectedFileUid,
      expectedFileGid: this.#expectedFileGid,
      expectedFileMode: REQUEST_FILE_MODE,
      minimumBytes: 1,
      maximumBytes: this.#maximumBytes,
      parseExisting: parseRequest,
      isSame: (existing) => serializeRequest(existing) === body,
      conflictMessage:
        "Live view policy request conflicts with an existing spool entry",
      temporaryId: this.#temporaryId,
    });
  }
}

export function assertRequestId(requestId: string): void {
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
    throw new RangeError("Live view policy request ID is invalid");
  }
}

export async function validateSafeSpoolDirectory(
  options: SafeSpoolDirectoryOptions,
): Promise<void> {
  const handle = await options.filesystem.open(
    options.directory,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      O_CLOEXEC |
      constants.O_NONBLOCK |
      constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory() ||
      metadata.uid !== options.expectedUid ||
      metadata.gid !== options.expectedGid ||
      (metadata.mode & 0o7777) !== options.expectedMode
    ) {
      throw new RangeError("Live view policy spool directory is unsafe");
    }
  } finally {
    await handle.close();
  }
}

export async function readSafeSpoolEntry<T>(
  options: SafeSpoolEntryOptions<T>,
): Promise<T> {
  const handle = await options.filesystem.open(
    options.path,
    constants.O_RDONLY |
      O_CLOEXEC |
      constants.O_NONBLOCK |
      constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    assertSafeSpoolEntryMetadata(metadata, options);
    const bytes = await readCapturedBytes(handle, metadata.size);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return options.parse(raw);
  } finally {
    await handle.close();
  }
}

export async function publishNoReplace<T>(
  options: PublishNoReplaceOptions<T>,
): Promise<"published" | "already-published"> {
  await validateSafeSpoolDirectory(options.directory);
  const bodyBytes = Buffer.byteLength(options.body);
  if (bodyBytes < options.minimumBytes || bodyBytes > options.maximumBytes) {
    throw new RangeError("Live view policy spool entry has an unsafe size");
  }

  const target = join(options.directory.directory, options.targetName);
  const temporaryId = options.temporaryId();
  if (!TEMPORARY_ID.test(temporaryId)) {
    throw new RangeError("Live view policy temporary ID is invalid");
  }
  const temporary = join(
    options.directory.directory,
    `.${options.targetName}.${temporaryId}.tmp`,
  );
  let handle: LiveViewPolicySpoolFileHandle | undefined;
  let temporaryExists = false;
  try {
    handle = await options.directory.filesystem.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        O_CLOEXEC |
        constants.O_NOFOLLOW,
      options.expectedFileMode,
    );
    temporaryExists = true;
    await handle.writeFile(options.body, "utf8");
    await handle.chmod(options.expectedFileMode);
    const metadata = await handle.stat();
    assertSafeSpoolEntryMetadata(metadata, {
      expectedUid: options.expectedFileUid,
      expectedGid: options.expectedFileGid,
      expectedMode: options.expectedFileMode,
      minimumBytes: options.minimumBytes,
      maximumBytes: options.maximumBytes,
    });
    if (metadata.size !== bodyBytes) {
      throw new RangeError(
        "Live view policy spool entry changed while writing",
      );
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await options.directory.filesystem.link(temporary, target);
    } catch (error: unknown) {
      if (!hasCode(error, "EEXIST")) throw error;
      await unlinkGeneratedTemporary(options.directory.filesystem, temporary);
      temporaryExists = false;
      await syncSafeSpoolDirectory(options.directory);
      const existing = await readExistingOrRecoverInterrupted(options, target);
      if (options.isSame(existing)) return "already-published";
      throw new RangeError(options.conflictMessage);
    }

    await unlinkGeneratedTemporary(options.directory.filesystem, temporary);
    temporaryExists = false;
    await syncSafeSpoolDirectory(options.directory);
    return "published";
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryExists) {
      const removed = await options.directory.filesystem
        .unlink(temporary)
        .then(() => true)
        .catch(() => false);
      if (removed) {
        await syncSafeSpoolDirectory(options.directory).catch(() => undefined);
      }
    }
  }
}

function serializeRequest(request: LiveViewPolicyRequestV1): string {
  if (request.kind === "settings-mutation") {
    return `${JSON.stringify({
      version: 1,
      kind: request.kind,
      requestId: request.requestId,
      expectedGeneration: request.expectedGeneration,
      rtspEnabled: request.rtspEnabled,
      settings: {
        enabled: request.settings.enabled,
        allowedCameraCidrs: request.settings.allowedCameraCidrs,
      },
    })}\n`;
  }
  return `${JSON.stringify({
    version: 1,
    kind: request.kind,
    requestId: request.requestId,
    expectedGeneration: request.expectedGeneration,
    rtspEnabled: request.rtspEnabled,
  })}\n`;
}

function parseRequest(raw: string): LiveViewPolicyRequestV1 {
  assertNoDuplicateJsonKeys(raw);
  return createLiveViewPolicyRequestV1(JSON.parse(raw) as unknown);
}

function assertSafeSpoolEntryMetadata(
  metadata: Stats,
  options: Pick<
    SafeSpoolEntryOptions<unknown>,
    | "expectedUid"
    | "expectedGid"
    | "expectedMode"
    | "minimumBytes"
    | "maximumBytes"
  >,
  allowedLinkCounts: readonly number[] = [1],
): void {
  if (
    !metadata.isFile() ||
    !allowedLinkCounts.includes(metadata.nlink) ||
    metadata.uid !== options.expectedUid ||
    metadata.gid !== options.expectedGid ||
    (metadata.mode & 0o7777) !== options.expectedMode ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < options.minimumBytes ||
    metadata.size > options.maximumBytes
  ) {
    throw new RangeError("Live view policy spool entry is unsafe");
  }
}

async function readCapturedBytes(
  handle: Pick<LiveViewPolicySpoolFileHandle, "read">,
  capturedSize: number,
): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(capturedSize + 1);
  let total = 0;
  while (total < bytes.length) {
    const { bytesRead } = await handle.read(
      bytes,
      total,
      bytes.length - total,
      total,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total !== capturedSize) {
    throw new RangeError("Live view policy spool entry changed while reading");
  }
  return bytes.subarray(0, capturedSize);
}

async function syncSafeSpoolDirectory(
  options: SafeSpoolDirectoryOptions,
): Promise<void> {
  const handle = await options.filesystem.open(
    options.directory,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      O_CLOEXEC |
      constants.O_NONBLOCK |
      constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isDirectory() ||
      metadata.uid !== options.expectedUid ||
      metadata.gid !== options.expectedGid ||
      (metadata.mode & 0o7777) !== options.expectedMode
    ) {
      throw new RangeError("Live view policy spool directory is unsafe");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readExistingOrRecoverInterrupted<T>(
  options: PublishNoReplaceOptions<T>,
  target: string,
): Promise<T> {
  const targetEntry = await readSpoolEntryWithMetadata(
    {
      path: target,
      expectedUid: options.expectedFileUid,
      expectedGid: options.expectedFileGid,
      expectedMode: options.expectedFileMode,
      minimumBytes: options.minimumBytes,
      maximumBytes: options.maximumBytes,
      parse: options.parseExisting,
      filesystem: options.directory.filesystem,
    },
    [1, 2],
    options.directory.filesystem,
  );
  if (targetEntry.metadata.nlink === 1) return targetEntry.value;
  if (!options.isSame(targetEntry.value)) {
    throw new RangeError(options.conflictMessage);
  }

  const prefix = `.${options.targetName}.`;
  const candidateNames = (
    await options.directory.filesystem.readdir(options.directory.directory)
  ).filter((name) => isGeneratedTemporaryName(name, prefix));
  let matchingTemporary: string | undefined;
  for (const candidateName of candidateNames) {
    const candidate = join(options.directory.directory, candidateName);
    let candidateEntry: Awaited<
      ReturnType<typeof readSpoolEntryWithMetadata<T>>
    >;
    try {
      candidateEntry = await readSpoolEntryWithMetadata(
        {
          path: candidate,
          expectedUid: options.expectedFileUid,
          expectedGid: options.expectedFileGid,
          expectedMode: options.expectedFileMode,
          minimumBytes: options.minimumBytes,
          maximumBytes: options.maximumBytes,
          parse: options.parseExisting,
          filesystem: options.directory.filesystem,
        },
        [1, 2],
        options.directory.filesystem,
      );
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (
      candidateEntry.metadata.dev === targetEntry.metadata.dev &&
      candidateEntry.metadata.ino === targetEntry.metadata.ino &&
      candidateEntry.metadata.nlink === 2 &&
      options.isSame(candidateEntry.value)
    ) {
      if (matchingTemporary !== undefined) {
        throw new RangeError(
          "Live view policy interrupted publication is unsafe",
        );
      }
      matchingTemporary = candidate;
    }
  }

  if (matchingTemporary !== undefined) {
    await unlinkGeneratedTemporary(
      options.directory.filesystem,
      matchingTemporary,
    );
    await syncSafeSpoolDirectory(options.directory);
  }

  const recovered = await readSafeSpoolEntry({
    path: target,
    expectedUid: options.expectedFileUid,
    expectedGid: options.expectedFileGid,
    expectedMode: options.expectedFileMode,
    minimumBytes: options.minimumBytes,
    maximumBytes: options.maximumBytes,
    parse: options.parseExisting,
    filesystem: options.directory.filesystem,
  });
  if (!options.isSame(recovered)) {
    throw new RangeError(options.conflictMessage);
  }
  return recovered;
}

async function readSpoolEntryWithMetadata<T>(
  options: SafeSpoolEntryOptions<T>,
  allowedLinkCounts: readonly number[],
  filesystem: LiveViewPolicySpoolFilesystem,
): Promise<{ readonly value: T; readonly metadata: Stats }> {
  const handle = await filesystem.open(
    options.path,
    constants.O_RDONLY |
      O_CLOEXEC |
      constants.O_NONBLOCK |
      constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    assertSafeSpoolEntryMetadata(metadata, options, allowedLinkCounts);
    const bytes = await readCapturedBytes(handle, metadata.size);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { value: options.parse(raw), metadata };
  } finally {
    await handle.close();
  }
}

function isGeneratedTemporaryName(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix) || !name.endsWith(".tmp")) return false;
  const temporaryId = name.slice(prefix.length, -".tmp".length);
  return TEMPORARY_ID.test(temporaryId);
}

async function unlinkGeneratedTemporary(
  filesystem: LiveViewPolicySpoolFilesystem,
  path: string,
): Promise<void> {
  try {
    await filesystem.unlink(path);
  } catch (error: unknown) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

function closeOnExecFlagFor(platform: NodeJS.Platform): number {
  if (platform === "linux") return 0x80000;
  if (platform === "darwin") return 0x1000000;
  throw new RangeError("Live view policy spool platform is unsupported");
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
