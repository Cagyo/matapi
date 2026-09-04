import { constants } from "node:fs";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LiveViewSettingsStateError } from "../../../src/camera/domain/errors/live-view-settings-state.error";
import { FsLiveViewMigrationAttentionAdapter } from "../../../src/camera/infrastructure/fs-live-view-migration-attention.adapter";
import {
  closeOnExecFlagFor,
  FsLiveViewSettingsAdapter,
} from "../../../src/camera/infrastructure/fs-live-view-settings.adapter";

const settingsV3 = {
  version: 1 as const,
  generation: 3,
  enabled: false,
  allowedCameraCidrs: ["192.168.1.0/24"],
};

describe("FsLiveViewSettingsAdapter", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture(
    body: string | Uint8Array = JSON.stringify(settingsV3),
  ) {
    const root = await mkdtemp(join(tmpdir(), "live-view-settings-"));
    roots.push(root);
    const path = join(root, "live-view-settings.json");
    await writeFile(path, body);
    await chmod(path, 0o640);
    return {
      path,
      adapter: new FsLiveViewSettingsAdapter({
        path,
        expectedUid: process.getuid?.() ?? -1,
        expectedGid: process.getgid?.() ?? -1,
      }),
    };
  }

  it("reads a valid document through a non-following, non-blocking close-on-exec descriptor", async () => {
    const { path } = await fixture();
    let observedFlags = 0;
    const adapter = new FsLiveViewSettingsAdapter({
      path,
      expectedUid: process.getuid?.() ?? -1,
      expectedGid: process.getgid?.() ?? -1,
      openFile: async (openedPath, flags) => {
        observedFlags = flags;
        return open(openedPath, flags);
      },
    });

    await expect(adapter.readCommitted()).resolves.toEqual(settingsV3);
    expect(observedFlags & constants.O_RDONLY).toBe(constants.O_RDONLY);
    expect(observedFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(observedFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    const closeOnExec = process.platform === "linux" ? 0x80000 : 0x1000000;
    expect(observedFlags & closeOnExec).toBe(closeOnExec);
  });

  it("uses the target ABI close-on-exec flag and refuses unsupported platforms", () => {
    expect(closeOnExecFlagFor("linux")).toBe(0x80000);
    expect(closeOnExecFlagFor("darwin")).toBe(0x1000000);
    expect(() => closeOnExecFlagFor("win32")).toThrow(
      LiveViewSettingsStateError,
    );
  });

  it("rejects an absent settings file", async () => {
    const root = await mkdtemp(join(tmpdir(), "live-view-settings-"));
    roots.push(root);
    const adapter = new FsLiveViewSettingsAdapter({
      path: join(root, "missing.json"),
      expectedUid: process.getuid?.() ?? -1,
      expectedGid: process.getgid?.() ?? -1,
    });

    await expect(adapter.readCommitted()).rejects.toMatchObject({
      name: "LiveViewSettingsStateError",
      reason: "unsafe-settings-state",
    });
  });

  it("rejects a symbolic link", async () => {
    const { path } = await fixture();
    const target = `${path}.target`;
    await writeFile(target, JSON.stringify(settingsV3));
    await unlink(path);
    await symlink(target, path);

    await expect(
      new FsLiveViewSettingsAdapter({
        path,
        expectedUid: process.getuid?.() ?? -1,
        expectedGid: process.getgid?.() ?? -1,
      }).readCommitted(),
    ).rejects.toBeInstanceOf(LiveViewSettingsStateError);
  });

  it("rejects a non-regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "live-view-settings-"));
    roots.push(root);
    const path = join(root, "live-view-settings.json");
    await mkdir(path);

    await expect(
      new FsLiveViewSettingsAdapter({
        path,
        expectedUid: process.getuid?.() ?? -1,
        expectedGid: process.getgid?.() ?? -1,
      }).readCommitted(),
    ).rejects.toBeInstanceOf(LiveViewSettingsStateError);
  });

  it.each([
    ["owner", { expectedUid: (process.getuid?.() ?? 0) + 1 }],
    ["group", { expectedGid: (process.getgid?.() ?? 0) + 1 }],
  ])("rejects a settings file with the wrong %s", async (_name, override) => {
    const { path } = await fixture();
    const adapter = new FsLiveViewSettingsAdapter({
      path,
      expectedUid: process.getuid?.() ?? -1,
      expectedGid: process.getgid?.() ?? -1,
      ...override,
    });

    await expect(adapter.readCommitted()).rejects.toBeInstanceOf(
      LiveViewSettingsStateError,
    );
  });

  it("rejects a settings file with a mode other than 0640", async () => {
    const { path, adapter } = await fixture();
    await chmod(path, 0o600);

    await expect(adapter.readCommitted()).rejects.toBeInstanceOf(
      LiveViewSettingsStateError,
    );
  });

  it.each([0o1640, 0o2640, 0o4640])(
    "rejects special mode bits in settings mode %o",
    async (mode) => {
      const { path } = await fixture();
      const adapter = new FsLiveViewSettingsAdapter({
        path,
        expectedUid: process.getuid?.() ?? -1,
        expectedGid: process.getgid?.() ?? -1,
        openFile: (openedPath, flags) =>
          openWithReportedMode(openedPath, flags, mode),
      });

      await expect(adapter.readCommitted()).rejects.toBeInstanceOf(
        LiveViewSettingsStateError,
      );
    },
  );

  it("rejects a settings file with more than one hard link", async () => {
    const { path, adapter } = await fixture();
    await link(path, `${path}.second-link`);

    await expect(adapter.readCommitted()).rejects.toBeInstanceOf(
      LiveViewSettingsStateError,
    );
  });

  it("rejects a settings file larger than 4 KiB", async () => {
    const { adapter } = await fixture(Buffer.alloc(4_097, 0x20));

    await expect(adapter.readCommitted()).rejects.toBeInstanceOf(
      LiveViewSettingsStateError,
    );
  });

  it("rejects invalid UTF-8 without exposing file bytes", async () => {
    const { adapter } = await fixture(Buffer.from([0xff, 0xfe, 0xfd]));

    await expect(adapter.readCommitted()).rejects.toMatchObject({
      name: "LiveViewSettingsStateError",
      message: "Live view settings state is invalid",
    });
  });

  it.each([
    [
      "duplicate keys",
      '{"version":1,"generation":3,"enabled":false,"enabled":true,"allowedCameraCidrs":[]}',
    ],
    [
      "escaped duplicate keys",
      '{"version":1,"generation":3,"enabled":false,"\\u0065nabled":true,"allowedCameraCidrs":[]}',
    ],
    [
      "unknown keys",
      '{"version":1,"generation":3,"enabled":false,"allowedCameraCidrs":[],"secret":"must-not-surface"}',
    ],
    [
      "invalid values",
      '{"version":1,"generation":-1,"enabled":false,"allowedCameraCidrs":[]}',
    ],
  ])("rejects %s with a sanitized state error", async (_name, body) => {
    const { adapter } = await fixture(body);

    await expect(adapter.readCommitted()).rejects.toMatchObject({
      name: "LiveViewSettingsStateError",
      message: "Live view settings state is invalid",
    });
  });

  it("rejects a file that grows between descriptor stat and bounded read", async () => {
    const { path } = await fixture();
    const adapter = new FsLiveViewSettingsAdapter({
      path,
      expectedUid: process.getuid?.() ?? -1,
      expectedGid: process.getgid?.() ?? -1,
      openFile: async (openedPath, flags) => {
        const handle = await open(openedPath, flags);
        return {
          stat: async () => {
            const captured = await handle.stat();
            await appendFile(path, " ");
            return captured;
          },
          read: handle.read.bind(handle),
          close: handle.close.bind(handle),
        };
      },
    });

    await expect(adapter.readCommitted()).rejects.toBeInstanceOf(
      LiveViewSettingsStateError,
    );
  });

  it("freezes the boot generation at the first read and cannot simulate a production restart", async () => {
    const { path, adapter } = await fixture();
    expect(adapter.bootLoadedGeneration()).toBeNull();
    await expect(adapter.readCommitted()).resolves.toEqual(settingsV3);
    expect(adapter.bootLoadedGeneration()).toBe(3);

    const settingsV4 = { ...settingsV3, generation: 4, enabled: true };
    await writeFile(path, JSON.stringify(settingsV4));
    await chmod(path, 0o640);
    await expect(adapter.readCommitted()).resolves.toEqual(settingsV4);
    expect(adapter.bootLoadedGeneration()).toBe(3);
    await expect(adapter.simulateDevelopmentRestart()).rejects.toMatchObject({
      name: "LiveViewSettingsStateError",
      reason: "development-operation-unavailable",
    });
    expect(adapter.bootLoadedGeneration()).toBe(3);
  });

  it("keeps a failed first boot read inactive after the authority is repaired in-process", async () => {
    const root = await mkdtemp(join(tmpdir(), "live-view-settings-"));
    roots.push(root);
    const path = join(root, "live-view-settings.json");
    const adapter = new FsLiveViewSettingsAdapter({
      path,
      expectedUid: process.getuid?.() ?? -1,
      expectedGid: process.getgid?.() ?? -1,
    });

    await expect(adapter.readCommitted()).rejects.toBeInstanceOf(
      LiveViewSettingsStateError,
    );
    await writeFile(path, JSON.stringify(settingsV3));
    await chmod(path, 0o640);
    await expect(adapter.readCommitted()).resolves.toEqual(settingsV3);
    expect(adapter.bootLoadedGeneration()).toBeNull();
  });
});

describe("FsLiveViewMigrationAttentionAdapter", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture(body?: string) {
    const root = await mkdtemp(join(tmpdir(), "live-view-attention-"));
    roots.push(root);
    const path = join(root, "live-view-settings-migration-attention.json");
    if (body !== undefined) {
      await writeFile(path, body);
      await chmod(path, 0o640);
    }
    return {
      path,
      adapter: new FsLiveViewMigrationAttentionAdapter({
        path,
        expectedUid: process.getuid?.() ?? -1,
        expectedGid: process.getgid?.() ?? -1,
      }),
    };
  }

  it("returns null when the bounded migration marker is absent", async () => {
    const { adapter } = await fixture();
    await expect(adapter.read()).resolves.toBeNull();
  });

  it("reads only the closed legacy-values-invalid marker vocabulary", async () => {
    const { adapter } = await fixture(
      '{"version":1,"code":"legacy-values-invalid"}',
    );

    await expect(adapter.read()).resolves.toBe("legacy-values-invalid");
  });

  it("opens the migration marker with the host close-on-exec flag", async () => {
    const { path } = await fixture(
      '{"version":1,"code":"legacy-values-invalid"}',
    );
    let observedFlags = 0;
    const adapter = new FsLiveViewMigrationAttentionAdapter({
      path,
      expectedUid: process.getuid?.() ?? -1,
      expectedGid: process.getgid?.() ?? -1,
      openFile: async (openedPath, flags) => {
        observedFlags = flags;
        return open(openedPath, flags);
      },
    });

    await expect(adapter.read()).resolves.toBe("legacy-values-invalid");
    const closeOnExec = process.platform === "linux" ? 0x80000 : 0x1000000;
    expect(observedFlags & closeOnExec).toBe(closeOnExec);
  });

  it("rejects special mode bits on the migration marker", async () => {
    const { path } = await fixture(
      '{"version":1,"code":"legacy-values-invalid"}',
    );
    const adapter = new FsLiveViewMigrationAttentionAdapter({
      path,
      expectedUid: process.getuid?.() ?? -1,
      expectedGid: process.getgid?.() ?? -1,
      openFile: (openedPath, flags) =>
        openWithReportedMode(openedPath, flags, 0o2640),
    });

    await expect(adapter.read()).rejects.toMatchObject({
      reason: "unsafe-settings-state",
    });
  });

  it.each([
    '{"version":1,"code":"legacy-values-invalid","legacy":"secret"}',
    '{"version":1,"code":"other"}',
    '{"version":1,"version":1,"code":"legacy-values-invalid"}',
  ])(
    "rejects malformed marker state without exposing its body",
    async (body) => {
      const { adapter } = await fixture(body);

      await expect(adapter.read()).rejects.toMatchObject({
        name: "LiveViewSettingsStateError",
        message: "Live view settings state is invalid",
      });
    },
  );
});

async function openWithReportedMode(
  path: string,
  flags: number,
  reportedMode: number,
) {
  const handle = await open(path, flags);
  return {
    stat: async () => {
      const metadata = await handle.stat();
      return new Proxy(metadata, {
        get(target, property) {
          if (property === "mode") {
            return (target.mode & ~0o7777) | reportedMode;
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    read: handle.read.bind(handle),
    close: handle.close.bind(handle),
  };
}
