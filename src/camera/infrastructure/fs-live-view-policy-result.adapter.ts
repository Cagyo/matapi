import { join } from "node:path";

import { LiveViewPolicyApplyError } from "../domain/errors/live-view-policy-apply.error";
import {
  createLiveViewPolicyResultV1,
  type LiveViewPolicyResultV1,
} from "../domain/live-view-policy";
import type { LiveViewPolicyResultPort } from "../domain/ports/live-view-policy-result.port";
import { assertNoDuplicateJsonKeys } from "./fs-live-view-settings.adapter";
import {
  assertRequestId,
  DEFAULT_LIVE_VIEW_POLICY_SPOOL_FILESYSTEM,
  hasCode,
  type LiveViewPolicySpoolFilesystem,
  readSafeSpoolEntry,
  type SafeSpoolDirectoryOptions,
  validateSafeSpoolDirectory,
} from "./fs-live-view-policy-request.adapter";

const DEFAULT_RESULT_DIRECTORY =
  "/var/lib/home-worker/live-view-settings-results";
const DEFAULT_MAXIMUM_BYTES = 4_096;
const RESULT_DIRECTORY_MODE = 0o750;
const RESULT_FILE_MODE = 0o640;
const ROOT_UID = 0;

export interface FsLiveViewPolicyResultOptions {
  readonly directory?: string;
  readonly expectedDirectoryUid?: number;
  readonly expectedDirectoryGid?: number;
  readonly expectedFileUid?: number;
  readonly expectedFileGid?: number;
  readonly maximumBytes?: number;
  readonly filesystem?: LiveViewPolicySpoolFilesystem;
}

export class FsLiveViewPolicyResultAdapter implements LiveViewPolicyResultPort {
  readonly #directory: SafeSpoolDirectoryOptions;
  readonly #expectedFileUid: number;
  readonly #expectedFileGid: number;
  readonly #maximumBytes: number;

  constructor(options: FsLiveViewPolicyResultOptions = {}) {
    this.#directory = {
      directory: options.directory ?? DEFAULT_RESULT_DIRECTORY,
      expectedUid: options.expectedDirectoryUid ?? ROOT_UID,
      expectedGid: options.expectedDirectoryGid ?? process.getgid?.() ?? -1,
      expectedMode: RESULT_DIRECTORY_MODE,
      filesystem:
        options.filesystem ?? DEFAULT_LIVE_VIEW_POLICY_SPOOL_FILESYSTEM,
    };
    this.#expectedFileUid = options.expectedFileUid ?? ROOT_UID;
    this.#expectedFileGid = options.expectedFileGid ?? process.getgid?.() ?? -1;
    this.#maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
  }

  async read(requestId: string): Promise<LiveViewPolicyResultV1 | null> {
    try {
      assertRequestId(requestId);
      await validateSafeSpoolDirectory(this.#directory);
    } catch {
      throw new LiveViewPolicyApplyError();
    }

    try {
      const result = await readSafeSpoolEntry({
        path: join(this.#directory.directory, `${requestId}.json`),
        expectedUid: this.#expectedFileUid,
        expectedGid: this.#expectedFileGid,
        expectedMode: RESULT_FILE_MODE,
        minimumBytes: 1,
        maximumBytes: this.#maximumBytes,
        parse: parseResult,
        filesystem: this.#directory.filesystem,
      });
      if (result.requestId !== requestId) throw new LiveViewPolicyApplyError();
      return result;
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) return null;
      throw new LiveViewPolicyApplyError();
    }
  }
}

function parseResult(raw: string): LiveViewPolicyResultV1 {
  assertNoDuplicateJsonKeys(raw);
  return createLiveViewPolicyResultV1(JSON.parse(raw) as unknown);
}
