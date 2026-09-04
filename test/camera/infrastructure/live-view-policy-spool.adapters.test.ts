import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
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
const TEMPORARY_ID = "11111111-1111-4111-8111-111111111111";
const uid = process.getuid?.() ?? -1;
const gid = process.getgid?.() ?? -1;
const canonicalRequestBody =
  '{"version":1,"kind":"settings-mutation","requestId":"AbCdEfGhIjKlMnOp","expectedGeneration":3,"rtspEnabled":true,"settings":{"enabled":true,"allowedCameraCidrs":["10.0.0.0/8","192.168.1.0/24"]}}\n';

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

interface FilesystemEvent {
  readonly operation:
    | "open"
    | "stat"
    | "read"
    | "write"
    | "chmod"
    | "sync"
    | "close"
    | "link"
    | "unlink"
    | "readdir";
  readonly role?: "directory" | "temporary" | "target";
  readonly flags?: number;
  readonly mode?: number;
}

function recordingFilesystem(
  directory: string,
  events: FilesystemEvent[],
  options: { readonly linkFailure?: NodeJS.ErrnoException } = {},
) {
  const roleOf = (path: string): NonNullable<FilesystemEvent["role"]> => {
    if (path === directory) return "directory";
    return path.endsWith(".tmp") ? "temporary" : "target";
  };
  const wrap = (
    handle: FileHandle,
    role: NonNullable<FilesystemEvent["role"]>,
  ) => ({
    stat: async (): Promise<Stats> => {
      events.push({ operation: "stat", role });
      return handle.stat();
    },
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      events.push({ operation: "read", role });
      return handle.read(buffer, offset, length, position);
    },
    writeFile: async (data: string, encoding: BufferEncoding) => {
      events.push({ operation: "write", role });
      await handle.writeFile(data, encoding);
    },
    chmod: async (mode: number) => {
      events.push({ operation: "chmod", role, mode });
      await handle.chmod(mode);
    },
    sync: async () => {
      events.push({ operation: "sync", role });
      await handle.sync();
    },
    close: async () => {
      events.push({ operation: "close", role });
      await handle.close();
    },
  });

  return {
    open: async (path: string, flags: number, mode?: number) => {
      const role = roleOf(path);
      events.push({ operation: "open", role, flags, mode });
      return wrap(await open(path, flags, mode), role);
    },
    link: async (source: string, target: string) => {
      events.push({ operation: "link" });
      if (options.linkFailure !== undefined) throw options.linkFailure;
      await link(source, target);
    },
    unlink: async (path: string) => {
      events.push({ operation: "unlink", role: roleOf(path) });
      await unlink(path);
    },
    readdir: async (path: string) => {
      events.push({ operation: "readdir", role: roleOf(path) });
      return readdir(path);
    },
  };
}

function sequence(events: readonly FilesystemEvent[]): string[] {
  return events.map(({ operation, role }) =>
    role === undefined ? operation : `${role}:${operation}`,
  );
}

async function expectInvalidResult(result: Promise<unknown>): Promise<void> {
  await expect(result).rejects.toMatchObject({
    name: "LiveViewPolicyApplyError",
    code: "LIVE_VIEW_POLICY_APPLY_INVALID",
    message: "Live view policy apply state is invalid",
  });
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
    expect(published).toBe(canonicalRequestBody);
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

    await chmod(fixtureValue.requestsDirectory, 0o770);

    const wrongOwner = new FsLiveViewPolicyRequestAdapter({
      directory: fixtureValue.requestsDirectory,
      expectedDirectoryUid: uid + 1,
      expectedDirectoryGid: gid,
      expectedFileUid: uid,
      expectedFileGid: gid,
    });
    await expect(wrongOwner.publish(request)).rejects.toThrow();

    const wrongGroup = new FsLiveViewPolicyRequestAdapter({
      directory: fixtureValue.requestsDirectory,
      expectedDirectoryUid: uid,
      expectedDirectoryGid: gid + 1,
      expectedFileUid: uid,
      expectedFileGid: gid,
    });
    await expect(wrongGroup.publish(request)).rejects.toThrow();
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
    await expectInvalidResult(results.read(REQUEST_ID));
    await chmod(resultPath, 0o640);
    await link(resultPath, `${resultPath}.second-link`);
    await expectInvalidResult(results.read(REQUEST_ID));
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
    await expectInvalidResult(wrongOwner.read(REQUEST_ID));

    await writeFile(resultPath, Buffer.alloc(4_097, 0x20));
    await chmod(resultPath, 0o640);
    await expectInvalidResult(
      new FsLiveViewPolicyResultAdapter({
        directory: resultsDirectory,
        expectedDirectoryUid: uid,
        expectedDirectoryGid: gid,
        expectedFileUid: uid,
        expectedFileGid: gid,
        maximumBytes: 4_096,
      }).read(REQUEST_ID),
    );

    await rm(resultPath);
    const outside = join(root, "outside-result.json");
    await writeFile(outside, `${JSON.stringify(successResult)}\n`, {
      mode: 0o640,
    });
    await symlink(outside, resultPath);
    await expectInvalidResult(
      new FsLiveViewPolicyResultAdapter({
        directory: resultsDirectory,
        expectedDirectoryUid: uid,
        expectedDirectoryGid: gid,
        expectedFileUid: uid,
        expectedFileGid: gid,
      }).read(REQUEST_ID),
    );

    await rm(resultPath);
    await writeFile(
      resultPath,
      `${JSON.stringify({ ...successResult, requestId: "PqRsTuVwXyZaBcDe" })}\n`,
      { mode: 0o640 },
    );
    await chmod(resultPath, 0o640);
    await expectInvalidResult(
      new FsLiveViewPolicyResultAdapter({
        directory: resultsDirectory,
        expectedDirectoryUid: uid,
        expectedDirectoryGid: gid,
        expectedFileUid: uid,
        expectedFileGid: gid,
      }).read(REQUEST_ID),
    );
  });

  it("rejects duplicate JSON keys in existing requests and terminal results", async () => {
    const { requests, requestsDirectory, results, resultsDirectory } =
      await fixture();
    const requestPath = join(requestsDirectory, `${REQUEST_ID}.json`);
    await writeFile(
      requestPath,
      canonicalRequestBody.replace(
        '"rtspEnabled":true',
        '"rtspEnabled":true,"rtspEnabled":true',
      ),
      { mode: 0o600 },
    );
    await chmod(requestPath, 0o600);
    await expect(requests.publish(request)).rejects.toMatchObject({
      name: "LiveViewSettingsStateError",
      message: "Live view settings state is invalid",
    });

    const resultPath = join(resultsDirectory, `${REQUEST_ID}.json`);
    await writeFile(
      resultPath,
      `${JSON.stringify(successResult).replace(
        '"outcome":"succeeded"',
        '"outcome":"succeeded","outcome":"succeeded"',
      )}\n`,
      { mode: 0o640 },
    );
    await chmod(resultPath, 0o640);
    await expectInvalidResult(results.read(REQUEST_ID));
  });

  it("makes the secure publication flags and durability ordering observable", async () => {
    const { requestsDirectory } = await fixture();
    const events: FilesystemEvent[] = [];
    const requests = new FsLiveViewPolicyRequestAdapter({
      directory: requestsDirectory,
      expectedDirectoryUid: uid,
      expectedDirectoryGid: gid,
      expectedFileUid: uid,
      expectedFileGid: gid,
      filesystem: recordingFilesystem(requestsDirectory, events),
      temporaryId: () => TEMPORARY_ID,
    });

    await expect(requests.publish(request)).resolves.toBe("published");

    expect(sequence(events)).toEqual([
      "directory:open",
      "directory:stat",
      "directory:close",
      "temporary:open",
      "temporary:write",
      "temporary:chmod",
      "temporary:stat",
      "temporary:sync",
      "temporary:close",
      "link",
      "temporary:unlink",
      "directory:open",
      "directory:stat",
      "directory:sync",
      "directory:close",
    ]);
    const directoryOpen = events.find(
      ({ operation, role }) => operation === "open" && role === "directory",
    );
    const temporaryOpen = events.find(
      ({ operation, role }) => operation === "open" && role === "temporary",
    );
    const directoryFlags = directoryOpen?.flags ?? 0;
    expect(directoryFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(directoryFlags & constants.O_DIRECTORY).toBe(constants.O_DIRECTORY);
    expect(directoryFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    const temporaryFlags = temporaryOpen?.flags ?? 0;
    expect(temporaryFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(temporaryFlags & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(temporaryFlags & constants.O_CREAT).toBe(constants.O_CREAT);
    expect(temporaryFlags & constants.O_WRONLY).toBe(constants.O_WRONLY);
    expect(temporaryOpen?.mode).toBe(0o600);
  });

  it("cleans and directory-syncs only its generated temp when publication fails", async () => {
    const { requestsDirectory } = await fixture();
    const events: FilesystemEvent[] = [];
    const linkFailure = Object.assign(new Error("injected link failure"), {
      code: "EIO",
    });
    const requests = new FsLiveViewPolicyRequestAdapter({
      directory: requestsDirectory,
      expectedDirectoryUid: uid,
      expectedDirectoryGid: gid,
      expectedFileUid: uid,
      expectedFileGid: gid,
      filesystem: recordingFilesystem(requestsDirectory, events, {
        linkFailure,
      }),
      temporaryId: () => TEMPORARY_ID,
    });
    const temporaryPath = join(
      requestsDirectory,
      `.${REQUEST_ID}.json.${TEMPORARY_ID}.tmp`,
    );

    await expect(requests.publish(request)).rejects.toMatchObject({
      code: "EIO",
    });
    await expect(lstat(temporaryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(join(requestsDirectory, `${REQUEST_ID}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(sequence(events).slice(-6)).toEqual([
      "link",
      "temporary:unlink",
      "directory:open",
      "directory:stat",
      "directory:sync",
      "directory:close",
    ]);
  });

  it("recovers strict interrupted request and acknowledgement hard links", async () => {
    const {
      requests,
      requestsDirectory,
      acknowledgements,
      acknowledgementsDirectory,
    } = await fixture();
    const requestTarget = join(requestsDirectory, `${REQUEST_ID}.json`);
    const requestOrphan = join(
      requestsDirectory,
      `.${REQUEST_ID}.json.${TEMPORARY_ID}.tmp`,
    );
    const unrelatedPreLinkTemporary = join(
      requestsDirectory,
      `.${REQUEST_ID}.json.33333333-3333-4333-8333-333333333333.tmp`,
    );
    await writeFile(unrelatedPreLinkTemporary, canonicalRequestBody, {
      mode: 0o600,
    });
    await chmod(unrelatedPreLinkTemporary, 0o600);
    await writeFile(requestOrphan, canonicalRequestBody, { mode: 0o600 });
    await chmod(requestOrphan, 0o600);
    await link(requestOrphan, requestTarget);
    expect((await lstat(requestTarget)).nlink).toBe(2);

    await expect(requests.publish(request)).resolves.toBe("already-published");
    expect((await lstat(requestTarget)).nlink).toBe(1);
    await expect(lstat(requestOrphan)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(unrelatedPreLinkTemporary)).nlink).toBe(1);

    const acknowledgementTarget = join(
      acknowledgementsDirectory,
      `${REQUEST_ID}.ack`,
    );
    const acknowledgementOrphan = join(
      acknowledgementsDirectory,
      `.${REQUEST_ID}.ack.${TEMPORARY_ID}.tmp`,
    );
    await writeFile(acknowledgementOrphan, "", { mode: 0o600 });
    await chmod(acknowledgementOrphan, 0o600);
    await link(acknowledgementOrphan, acknowledgementTarget);
    expect((await lstat(acknowledgementTarget)).nlink).toBe(2);

    await expect(acknowledgements.publish(REQUEST_ID)).resolves.toBe(
      "already-published",
    );
    expect((await lstat(acknowledgementTarget)).nlink).toBe(1);
    await expect(lstat(acknowledgementOrphan)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers a linked target without deleting malformed temps left by earlier crashes", async () => {
    const { requestsDirectory } = await fixture();
    const requestTarget = join(requestsDirectory, `${REQUEST_ID}.json`);
    const zeroByteTemporaryName = `.${REQUEST_ID}.json.00000000-0000-4000-8000-000000000000.tmp`;
    const partialTemporaryName = `.${REQUEST_ID}.json.99999999-9999-4999-8999-999999999999.tmp`;
    const requestOrphanName = `.${REQUEST_ID}.json.${TEMPORARY_ID}.tmp`;
    const zeroByteTemporary = join(requestsDirectory, zeroByteTemporaryName);
    const partialTemporary = join(requestsDirectory, partialTemporaryName);
    const requestOrphan = join(requestsDirectory, requestOrphanName);
    const partialBody = canonicalRequestBody.slice(0, 47);
    const recoveryOrder = [
      zeroByteTemporaryName,
      partialTemporaryName,
      requestOrphanName,
    ];
    const requests = new FsLiveViewPolicyRequestAdapter({
      directory: requestsDirectory,
      expectedDirectoryUid: uid,
      expectedDirectoryGid: gid,
      expectedFileUid: uid,
      expectedFileGid: gid,
      filesystem: {
        open,
        link,
        unlink,
        readdir: async (path: string) => {
          const names = await readdir(path);
          return [...names].sort(
            (left, right) =>
              recoveryOrder.indexOf(left) - recoveryOrder.indexOf(right),
          );
        },
      },
    });

    await writeFile(zeroByteTemporary, "", { mode: 0o600 });
    await chmod(zeroByteTemporary, 0o600);
    await writeFile(partialTemporary, partialBody, { mode: 0o600 });
    await chmod(partialTemporary, 0o600);
    await writeFile(requestOrphan, canonicalRequestBody, { mode: 0o600 });
    await chmod(requestOrphan, 0o600);
    await link(requestOrphan, requestTarget);
    expect((await lstat(requestTarget)).nlink).toBe(2);

    await expect(requests.publish(request)).resolves.toBe("already-published");

    expect((await lstat(requestTarget)).nlink).toBe(1);
    await expect(lstat(requestOrphan)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(zeroByteTemporary)).nlink).toBe(1);
    expect(await readFile(zeroByteTemporary, "utf8")).toBe("");
    expect((await lstat(partialTemporary)).nlink).toBe(1);
    expect(await readFile(partialTemporary, "utf8")).toBe(partialBody);
  });

  it("lets a canonical concurrent retry finish an in-flight linked publication", async () => {
    const { requestsDirectory } = await fixture();
    let linkCalls = 0;
    let linked!: () => void;
    let release!: () => void;
    const linkedPromise = new Promise<void>((resolve) => {
      linked = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const temporaryIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const filesystem = {
      open,
      readdir,
      unlink,
      link: async (source: string, target: string) => {
        await link(source, target);
        linkCalls += 1;
        if (linkCalls === 1) {
          linked();
          await releasePromise;
        }
      },
    };
    const requests = new FsLiveViewPolicyRequestAdapter({
      directory: requestsDirectory,
      expectedDirectoryUid: uid,
      expectedDirectoryGid: gid,
      expectedFileUid: uid,
      expectedFileGid: gid,
      filesystem,
      temporaryId: () => temporaryIds.shift() ?? TEMPORARY_ID,
    });

    const first = requests.publish(request);
    const firstReachedLink = await Promise.race([
      linkedPromise.then(() => true),
      first.then(() => false),
    ]);
    expect(firstReachedLink, "the injected filesystem seam was bypassed").toBe(
      true,
    );

    let second: "published" | "already-published" | undefined;
    try {
      second = await requests.publish(request);
    } finally {
      release();
    }
    await expect(first).resolves.toBe("published");
    expect(second).toBe("already-published");
    expect(
      (await lstat(join(requestsDirectory, `${REQUEST_ID}.json`))).nlink,
    ).toBe(1);
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
