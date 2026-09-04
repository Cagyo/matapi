import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { LiveViewPolicyRequestV1 } from "../../../src/camera/domain/live-view-policy";
import { createLiveViewPolicyResultV1 } from "../../../src/camera/domain/live-view-policy";
import { FsLiveViewPolicyAcknowledgementAdapter } from "../../../src/camera/infrastructure/fs-live-view-policy-acknowledgement.adapter";
import { FsLiveViewPolicyRequestAdapter } from "../../../src/camera/infrastructure/fs-live-view-policy-request.adapter";
import { FsLiveViewPolicyResultAdapter } from "../../../src/camera/infrastructure/fs-live-view-policy-result.adapter";

const REQUEST_ID = "AbCdEfGhIjKlMnOp";
const uid = process.getuid?.() ?? -1;
const gid = process.getgid?.() ?? -1;

const request: LiveViewPolicyRequestV1 = {
  version: 1,
  kind: "settings-mutation",
  requestId: REQUEST_ID,
  expectedGeneration: 3,
  rtspEnabled: true,
  settings: {
    enabled: true,
    allowedCameraCidrs: ["192.168.1.77/24", "10.20.30.40/8"],
  },
};

const successResult = createLiveViewPolicyResultV1({
  version: 1,
  kind: "settings-mutation",
  requestId: REQUEST_ID,
  outcome: "succeeded",
  resultingGeneration: 4,
  resultingRtspEnabled: true,
  failureCode: null,
});

interface Fixture {
  readonly root: string;
  readonly requestsDirectory: string;
  readonly resultsDirectory: string;
  readonly acknowledgementsDirectory: string;
  readonly requests: FsLiveViewPolicyRequestAdapter;
  readonly results: FsLiveViewPolicyResultAdapter;
  readonly acknowledgements: FsLiveViewPolicyAcknowledgementAdapter;
}

describe("live view policy spool adapters", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture(): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "live-view-policy-spool-"));
    roots.push(root);
    const requestsDirectory = join(root, "requests");
    const resultsDirectory = join(root, "results");
    const acknowledgementsDirectory = join(root, "acks");
    await mkdir(requestsDirectory, { mode: 0o770 });
    await mkdir(resultsDirectory, { mode: 0o750 });
    await mkdir(acknowledgementsDirectory, { mode: 0o770 });
    await chmod(requestsDirectory, 0o770);
    await chmod(resultsDirectory, 0o750);
    await chmod(acknowledgementsDirectory, 0o770);

    return {
      root,
      requestsDirectory,
      resultsDirectory,
      acknowledgementsDirectory,
      requests: new FsLiveViewPolicyRequestAdapter({
        directory: requestsDirectory,
        expectedDirectoryUid: uid,
        expectedDirectoryGid: gid,
        expectedFileUid: uid,
        expectedFileGid: gid,
      }),
      results: new FsLiveViewPolicyResultAdapter({
        directory: resultsDirectory,
        expectedDirectoryUid: uid,
        expectedDirectoryGid: gid,
        expectedFileUid: uid,
        expectedFileGid: gid,
      }),
      acknowledgements: new FsLiveViewPolicyAcknowledgementAdapter({
        directory: acknowledgementsDirectory,
        expectedDirectoryUid: uid,
        expectedDirectoryGid: gid,
        expectedFileUid: uid,
        expectedFileGid: gid,
      }),
    };
  }

  it("publishes once without replacement and accepts a canonically identical duplicate", async () => {
    const { requests, requestsDirectory } = await fixture();
    const requestPath = join(requestsDirectory, `${REQUEST_ID}.json`);

    await expect(requests.publish(request)).resolves.toBe("published");
    const published = await readFile(requestPath, "utf8");
    expect(published).toBe(
      '{"version":1,"kind":"settings-mutation","requestId":"AbCdEfGhIjKlMnOp","expectedGeneration":3,"rtspEnabled":true,"settings":{"enabled":true,"allowedCameraCidrs":["10.0.0.0/8","192.168.1.0/24"]}}\n',
    );
    expect((await lstat(requestPath)).mode & 0o7777).toBe(0o600);

    await expect(
      requests.publish({
        ...request,
        settings: {
          enabled: true,
          allowedCameraCidrs: ["10.0.0.0/8", "192.168.1.0/24"],
        },
      }),
    ).resolves.toBe("already-published");

    await expect(
      requests.publish({ ...request, expectedGeneration: 4 }),
    ).rejects.toThrow(/conflict/iu);
    await expect(readFile(requestPath, "utf8")).resolves.toBe(published);
  });

  it("rejects symlinked directories and existing symlink entries without following them", async () => {
    const { root, requestsDirectory } = await fixture();
    const directoryLink = join(root, "requests-link");
    await symlink(requestsDirectory, directoryLink);
    const throughDirectoryLink = new FsLiveViewPolicyRequestAdapter({
      directory: directoryLink,
      expectedDirectoryUid: uid,
      expectedDirectoryGid: gid,
      expectedFileUid: uid,
      expectedFileGid: gid,
    });
    await expect(throughDirectoryLink.publish(request)).rejects.toThrow();

    const outside = join(root, "outside.json");
    await writeFile(outside, "do-not-read-or-replace", { mode: 0o600 });
    await symlink(outside, join(requestsDirectory, `${REQUEST_ID}.json`));
    const requests = new FsLiveViewPolicyRequestAdapter({
      directory: requestsDirectory,
      expectedDirectoryUid: uid,
      expectedDirectoryGid: gid,
      expectedFileUid: uid,
      expectedFileGid: gid,
    });
    await expect(requests.publish(request)).rejects.toThrow();
    await expect(readFile(outside, "utf8")).resolves.toBe(
      "do-not-read-or-replace",
    );
  });

  it("requires the exact mode and injected ownership for every spool directory", async () => {
    const fixtureValue = await fixture();
    await chmod(fixtureValue.requestsDirectory, 0o750);
    await expect(fixtureValue.requests.publish(request)).rejects.toThrow();

    await chmod(fixtureValue.resultsDirectory, 0o770);
    await expect(fixtureValue.results.read(REQUEST_ID)).rejects.toThrow();

    await chmod(fixtureValue.acknowledgementsDirectory, 0o750);
    await expect(
      fixtureValue.acknowledgements.publish(REQUEST_ID),
    ).rejects.toThrow();

    const wrongOwner = new FsLiveViewPolicyRequestAdapter({
      directory: fixtureValue.requestsDirectory,
      expectedDirectoryUid: uid + 1,
      expectedDirectoryGid: gid,
      expectedFileUid: uid,
      expectedFileGid: gid,
    });
    await expect(wrongOwner.publish(request)).rejects.toThrow();
  });

  it("reads only a bounded root-modelled regular 0640 terminal result from its descriptor", async () => {
    const { results, resultsDirectory } = await fixture();
    const resultPath = join(resultsDirectory, `${REQUEST_ID}.json`);
    await writeFile(resultPath, `${JSON.stringify(successResult)}\n`, {
      mode: 0o640,
    });
    await chmod(resultPath, 0o640);

    await expect(results.read(REQUEST_ID)).resolves.toEqual(successResult);
    expect("remove" in results).toBe(false);
    expect("unlink" in results).toBe(false);

    await chmod(resultPath, 0o600);
    await expect(results.read(REQUEST_ID)).rejects.toThrow();
    await chmod(resultPath, 0o640);
    await link(resultPath, `${resultPath}.second-link`);
    await expect(results.read(REQUEST_ID)).rejects.toThrow();
  });

  it("rejects unsafe result ownership, oversized content, symlinks, and mismatched correlation", async () => {
    const { root, resultsDirectory } = await fixture();
    const resultPath = join(resultsDirectory, `${REQUEST_ID}.json`);
    await writeFile(resultPath, `${JSON.stringify(successResult)}\n`, {
      mode: 0o640,
    });
    await chmod(resultPath, 0o640);

    const wrongOwner = new FsLiveViewPolicyResultAdapter({
      directory: resultsDirectory,
      expectedDirectoryUid: uid,
      expectedDirectoryGid: gid,
      expectedFileUid: uid + 1,
      expectedFileGid: gid,
    });
    await expect(wrongOwner.read(REQUEST_ID)).rejects.toThrow();

    await writeFile(resultPath, Buffer.alloc(4_097, 0x20));
    await chmod(resultPath, 0o640);
    await expect(
      new FsLiveViewPolicyResultAdapter({
        directory: resultsDirectory,
        expectedDirectoryUid: uid,
        expectedDirectoryGid: gid,
        expectedFileUid: uid,
        expectedFileGid: gid,
        maximumBytes: 4_096,
      }).read(REQUEST_ID),
    ).rejects.toThrow();

    await rm(resultPath);
    const outside = join(root, "outside-result.json");
    await writeFile(outside, `${JSON.stringify(successResult)}\n`, {
      mode: 0o640,
    });
    await symlink(outside, resultPath);
    await expect(
      new FsLiveViewPolicyResultAdapter({
        directory: resultsDirectory,
        expectedDirectoryUid: uid,
        expectedDirectoryGid: gid,
        expectedFileUid: uid,
        expectedFileGid: gid,
      }).read(REQUEST_ID),
    ).rejects.toThrow();

    await rm(resultPath);
    await writeFile(
      resultPath,
      `${JSON.stringify({ ...successResult, requestId: "PqRsTuVwXyZaBcDe" })}\n`,
      { mode: 0o640 },
    );
    await chmod(resultPath, 0o640);
    await expect(
      new FsLiveViewPolicyResultAdapter({
        directory: resultsDirectory,
        expectedDirectoryUid: uid,
        expectedDirectoryGid: gid,
        expectedFileUid: uid,
        expectedFileGid: gid,
      }).read(REQUEST_ID),
    ).rejects.toThrow();
  });

  it("returns null for an absent terminal result after validating its directory", async () => {
    const { results } = await fixture();
    await expect(results.read(REQUEST_ID)).resolves.toBeNull();
  });

  it("atomically publishes an idempotent worker-owned 0600 acknowledgement", async () => {
    const { acknowledgements, acknowledgementsDirectory } = await fixture();
    const acknowledgementPath = join(
      acknowledgementsDirectory,
      `${REQUEST_ID}.ack`,
    );

    await expect(acknowledgements.publish(REQUEST_ID)).resolves.toBe(
      "published",
    );
    expect((await lstat(acknowledgementPath)).mode & 0o7777).toBe(0o600);
    expect((await lstat(acknowledgementPath)).size).toBe(0);
    await expect(acknowledgements.publish(REQUEST_ID)).resolves.toBe(
      "already-published",
    );

    await writeFile(acknowledgementPath, "unsafe");
    await chmod(acknowledgementPath, 0o600);
    await expect(acknowledgements.publish(REQUEST_ID)).rejects.toThrow();
  });
});
