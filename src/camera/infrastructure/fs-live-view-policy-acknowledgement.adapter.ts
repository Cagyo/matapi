import { randomUUID } from "node:crypto";

import type { LiveViewPolicyAcknowledgementPort } from "../domain/ports/live-view-policy-acknowledgement.port";
import {
  assertRequestId,
  DEFAULT_LIVE_VIEW_POLICY_SPOOL_FILESYSTEM,
  type LiveViewPolicySpoolFilesystem,
  publishNoReplace,
  type SafeSpoolDirectoryOptions,
} from "./fs-live-view-policy-request.adapter";

const DEFAULT_ACKNOWLEDGEMENT_DIRECTORY =
  "/var/lib/home-worker/live-view-settings-acks";
const ACKNOWLEDGEMENT_DIRECTORY_MODE = 0o770;
const ACKNOWLEDGEMENT_FILE_MODE = 0o600;
const ROOT_UID = 0;

export interface FsLiveViewPolicyAcknowledgementOptions {
  readonly directory?: string;
  readonly expectedDirectoryUid?: number;
  readonly expectedDirectoryGid?: number;
  readonly expectedFileUid?: number;
  readonly expectedFileGid?: number;
  readonly filesystem?: LiveViewPolicySpoolFilesystem;
  readonly temporaryId?: () => string;
}

export class FsLiveViewPolicyAcknowledgementAdapter implements LiveViewPolicyAcknowledgementPort {
  readonly #directory: SafeSpoolDirectoryOptions;
  readonly #expectedFileUid: number;
  readonly #expectedFileGid: number;
  readonly #temporaryId: () => string;

  constructor(options: FsLiveViewPolicyAcknowledgementOptions = {}) {
    this.#directory = {
      directory: options.directory ?? DEFAULT_ACKNOWLEDGEMENT_DIRECTORY,
      expectedUid: options.expectedDirectoryUid ?? ROOT_UID,
      expectedGid: options.expectedDirectoryGid ?? process.getgid?.() ?? -1,
      expectedMode: ACKNOWLEDGEMENT_DIRECTORY_MODE,
      filesystem:
        options.filesystem ?? DEFAULT_LIVE_VIEW_POLICY_SPOOL_FILESYSTEM,
    };
    this.#expectedFileUid = options.expectedFileUid ?? process.getuid?.() ?? -1;
    this.#expectedFileGid = options.expectedFileGid ?? process.getgid?.() ?? -1;
    this.#temporaryId = options.temporaryId ?? randomUUID;
  }

  async publish(requestId: string): Promise<"published" | "already-published"> {
    assertRequestId(requestId);
    return publishNoReplace({
      directory: this.#directory,
      targetName: `${requestId}.ack`,
      body: "",
      expectedFileUid: this.#expectedFileUid,
      expectedFileGid: this.#expectedFileGid,
      expectedFileMode: ACKNOWLEDGEMENT_FILE_MODE,
      minimumBytes: 0,
      maximumBytes: 0,
      parseExisting: (raw) => {
        if (raw !== "") {
          throw new RangeError("Live view policy acknowledgement is invalid");
        }
        return raw;
      },
      isSame: (existing) => existing === "",
      conflictMessage:
        "Live view policy acknowledgement conflicts with an existing spool entry",
      temporaryId: this.#temporaryId,
    });
  }
}
