import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReadinessMarkerAdapter,
  readinessContextFromEnvironment,
} from "../../../src/system/infrastructure/readiness-marker.adapter";

const OPERATION_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const ARTIFACT_SHA = "a".repeat(64);
const METADATA_SHA = "b".repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ReadinessMarkerAdapter", () => {
  it("atomically publishes the exact operation-bound active identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ota-ready-"));
    roots.push(root);
    await mkdir(join(root, "run"));
    const markerPath = join(root, "run", "ready.json");
    const adapter = new ReadinessMarkerAdapter(markerPath, {
      now: () => new Date("2030-01-15T00:00:00.000Z"),
      pid: () => 321,
      token: () => "fixed",
    });

    await adapter.publish({
      operationId: OPERATION_ID,
      artifactSha256: ARTIFACT_SHA,
      metadataSha256: METADATA_SHA,
    });

    expect(JSON.parse(await readFile(markerPath, "utf8"))).toEqual({
      schemaVersion: 1,
      operationId: OPERATION_ID,
      pid: 321,
      artifactSha256: ARTIFACT_SHA,
      metadataSha256: METADATA_SHA,
      writtenAt: "2030-01-15T00:00:00.000Z",
    });
  });

  it("treats a partially supplied readiness context as invalid", () => {
    expect(() =>
      readinessContextFromEnvironment({
        HOME_WORKER_OTA_OPERATION_ID: OPERATION_ID,
        HOME_WORKER_OTA_ARTIFACT_SHA256: ARTIFACT_SHA,
      }),
    ).toThrow(/readiness context/i);
  });

  it("does not publish outside an activation when no context is supplied", () => {
    expect(readinessContextFromEnvironment({})).toBeNull();
  });
});
