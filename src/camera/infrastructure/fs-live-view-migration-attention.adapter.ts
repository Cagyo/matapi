import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import { LiveViewSettingsStateError } from "../domain/errors/live-view-settings-state.error";
import type {
  LiveViewMigrationAttention,
  LiveViewMigrationAttentionPort,
} from "../domain/ports/live-view-migration-attention.port";
import {
  assertNoDuplicateJsonKeys,
  assertSafeMetadata,
  readBounded,
} from "./fs-live-view-settings.adapter";

const DEFAULT_ATTENTION_PATH =
  "/var/lib/home-worker/live-view-settings-migration-attention.json";
const MAX_ATTENTION_BYTES = 4_096;
const ATTENTION_MODE = 0o640;
const ROOT_UID = 0;
const O_CLOEXEC =
  (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;

type AttentionFileHandle = Pick<FileHandle, "stat" | "read" | "close">;
type OpenAttentionFile = (
  path: string,
  flags: number,
) => Promise<AttentionFileHandle>;

export interface FsLiveViewMigrationAttentionOptions {
  readonly path?: string;
  readonly expectedUid?: number;
  readonly expectedGid?: number;
  readonly openFile?: OpenAttentionFile;
}

export class FsLiveViewMigrationAttentionAdapter implements LiveViewMigrationAttentionPort {
  readonly #path: string;
  readonly #expectedUid: number;
  readonly #expectedGid: number;
  readonly #openFile: OpenAttentionFile;

  constructor(options: FsLiveViewMigrationAttentionOptions = {}) {
    this.#path = options.path ?? DEFAULT_ATTENTION_PATH;
    this.#expectedUid = options.expectedUid ?? ROOT_UID;
    this.#expectedGid = options.expectedGid ?? process.getgid?.() ?? -1;
    this.#openFile = options.openFile ?? open;
  }

  async read(): Promise<LiveViewMigrationAttention | null> {
    let handle: AttentionFileHandle;
    try {
      handle = await this.#openFile(
        this.#path,
        constants.O_RDONLY |
          O_CLOEXEC |
          constants.O_NONBLOCK |
          constants.O_NOFOLLOW,
      );
    } catch (error: unknown) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw new LiveViewSettingsStateError("unsafe-settings-state");
    }

    try {
      const metadata = await handle.stat();
      assertSafeMetadata(
        metadata,
        this.#expectedUid,
        this.#expectedGid,
        ATTENTION_MODE,
        MAX_ATTENTION_BYTES,
      );
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(
        await readBounded(handle, metadata.size),
      );
      assertNoDuplicateJsonKeys(raw);
      const marker = JSON.parse(raw) as unknown;
      if (
        !isRecord(marker) ||
        Object.keys(marker).length !== 2 ||
        marker.version !== 1 ||
        marker.code !== "legacy-values-invalid"
      ) {
        throw new LiveViewSettingsStateError();
      }
      return "legacy-values-invalid";
    } catch {
      throw new LiveViewSettingsStateError("unsafe-settings-state");
    } finally {
      await handle.close().catch(() => {
        throw new LiveViewSettingsStateError("unsafe-settings-state");
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
