import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  parseOtaOperationId,
  parseReadinessMarker,
  type ReadinessMarker,
} from "../domain/ota-contracts";

const SHA256 = /^[0-9a-f]{64}$/;

export interface ReadinessContext {
  operationId: string;
  artifactSha256: string;
  metadataSha256: string;
}

export interface ReadinessMarkerOptions {
  now(): Date;
  pid(): number;
  token(): string;
}

const defaultOptions: ReadinessMarkerOptions = {
  now: () => new Date(),
  pid: () => process.pid,
  token: () => randomBytes(8).toString("hex"),
};

function exactContext(input: ReadinessContext): ReadinessContext {
  const operationId = parseOtaOperationId(input.operationId);
  if (
    !SHA256.test(input.artifactSha256) ||
    !SHA256.test(input.metadataSha256)
  ) {
    throw new Error("invalid OTA readiness context");
  }
  return {
    operationId,
    artifactSha256: input.artifactSha256,
    metadataSha256: input.metadataSha256,
  };
}

export function readinessContextFromEnvironment(
  env: NodeJS.ProcessEnv,
): ReadinessContext | null {
  const values = [
    env.HOME_WORKER_OTA_OPERATION_ID,
    env.HOME_WORKER_OTA_ARTIFACT_SHA256,
    env.HOME_WORKER_OTA_METADATA_SHA256,
  ];
  if (values.every((value) => value === undefined)) return null;
  if (values.some((value) => value === undefined)) {
    throw new Error("incomplete OTA readiness context");
  }
  return exactContext({
    operationId: values[0]!,
    artifactSha256: values[1]!,
    metadataSha256: values[2]!,
  });
}

export class ReadinessMarkerAdapter {
  constructor(
    private readonly markerPath = "/run/home-worker/ready.json",
    private readonly options: ReadinessMarkerOptions = defaultOptions,
  ) {}

  async publish(input: ReadinessContext): Promise<void> {
    const context = exactContext(input);
    const pid = this.options.pid();
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("invalid OTA readiness PID");
    }
    const marker: ReadinessMarker = parseReadinessMarker({
      schemaVersion: 1,
      ...context,
      pid,
      writtenAt: this.options.now().toISOString(),
    });
    const directoryPath = dirname(this.markerPath);
    const temporaryPath = resolve(
      directoryPath,
      `.${basename(this.markerPath)}.${pid}.${this.options.token()}.tmp`,
    );
    let handle;
    let renamed = false;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(Buffer.from(JSON.stringify(marker), "utf8"));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.markerPath);
      renamed = true;
      const directory = await open(
        directoryPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle?.close();
      if (!renamed) await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
