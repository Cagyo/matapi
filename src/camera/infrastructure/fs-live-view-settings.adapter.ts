import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { LiveViewSettingsStateError } from "../domain/errors/live-view-settings-state.error";
import {
  createLiveViewSettingsDocument,
  type LiveViewSettingsDocument,
} from "../domain/live-view-settings";
import type { LiveViewSettingsStorePort } from "../domain/ports/live-view-settings-store.port";

const DEFAULT_SETTINGS_PATH = "/var/lib/home-worker/live-view-settings.json";
const MAX_SETTINGS_BYTES = 4_096;
const SETTINGS_MODE = 0o640;
const ROOT_UID = 0;
const O_CLOEXEC = closeOnExecFlagFor(process.platform);

type SettingsFileHandle = Pick<FileHandle, "stat" | "read" | "close">;
type OpenSettingsFile = (
  path: string,
  flags: number,
) => Promise<SettingsFileHandle>;

export interface FsLiveViewSettingsOptions {
  readonly path?: string;
  readonly expectedUid?: number;
  readonly expectedGid?: number;
  readonly openFile?: OpenSettingsFile;
}

export function closeOnExecFlagFor(platform: NodeJS.Platform): number {
  // Node does not expose O_CLOEXEC in `fs.constants`; these are the stable
  // target ABI values from Linux and Darwin fcntl headers.
  if (platform === "linux") return 0x80000;
  if (platform === "darwin") return 0x1000000;
  throw new LiveViewSettingsStateError("unsafe-settings-state");
}

export class FsLiveViewSettingsAdapter implements LiveViewSettingsStorePort {
  readonly #path: string;
  readonly #expectedUid: number;
  readonly #expectedGid: number;
  readonly #openFile: OpenSettingsFile;
  #bootGeneration: number | null = null;
  #bootCaptureComplete = false;

  constructor(options: FsLiveViewSettingsOptions = {}) {
    this.#path = options.path ?? DEFAULT_SETTINGS_PATH;
    this.#expectedUid = options.expectedUid ?? ROOT_UID;
    this.#expectedGid = options.expectedGid ?? process.getgid?.() ?? -1;
    this.#openFile = options.openFile ?? open;
  }

  async readCommitted(): Promise<LiveViewSettingsDocument> {
    try {
      const settings = await this.#readSafe();
      if (!this.#bootCaptureComplete) {
        this.#bootGeneration = settings.generation;
        this.#bootCaptureComplete = true;
      }
      return settings;
    } catch {
      if (!this.#bootCaptureComplete) this.#bootCaptureComplete = true;
      throw new LiveViewSettingsStateError("unsafe-settings-state");
    }
  }

  bootLoadedGeneration(): number | null {
    return this.#bootGeneration;
  }

  async simulateDevelopmentRestart(): Promise<void> {
    throw new LiveViewSettingsStateError("development-operation-unavailable");
  }

  async #readSafe(): Promise<LiveViewSettingsDocument> {
    const handle = await this.#openFile(
      this.#path,
      constants.O_RDONLY |
        O_CLOEXEC |
        constants.O_NONBLOCK |
        constants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      assertSafeMetadata(
        metadata,
        this.#expectedUid,
        this.#expectedGid,
        SETTINGS_MODE,
        MAX_SETTINGS_BYTES,
      );
      const bytes = await readBounded(handle, metadata.size);
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      assertNoDuplicateJsonKeys(raw);
      return createLiveViewSettingsDocument(JSON.parse(raw) as unknown);
    } finally {
      await handle.close();
    }
  }
}

export function assertSafeMetadata(
  metadata: Stats,
  expectedUid: number,
  expectedGid: number,
  expectedMode: number,
  maximumBytes: number,
): void {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.uid !== expectedUid ||
    metadata.gid !== expectedGid ||
    (metadata.mode & 0o7777) !== expectedMode ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    throw new LiveViewSettingsStateError();
  }
}

export async function readBounded(
  handle: Pick<FileHandle, "read">,
  capturedSize: number,
): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(capturedSize + 1);
  let total = 0;
  while (total < bytes.length) {
    const result = await handle.read(bytes, total, bytes.length - total, total);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
  }
  if (total !== capturedSize) throw new LiveViewSettingsStateError();
  return bytes.subarray(0, capturedSize);
}

const JSON_PROPERTY =
  // JSON strings cannot contain unescaped control characters.
  // eslint-disable-next-line no-control-regex
  /"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001f])*"\s*:/gu;

export function assertNoDuplicateJsonKeys(raw: string): void {
  const keys = new Set<string>();
  for (const match of raw.matchAll(JSON_PROPERTY)) {
    const propertyToken = match[0].slice(0, match[0].lastIndexOf(":")).trim();
    const key = JSON.parse(propertyToken) as unknown;
    if (typeof key !== "string" || keys.has(key)) {
      throw new LiveViewSettingsStateError();
    }
    keys.add(key);
  }
}
