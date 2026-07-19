import { describe, expect, it, vi } from "vitest";
import { catalogFor } from "../../../src/locales";
import { UpdateHandler } from "../../../src/telegram/interfaces/update.handler";

const checked = {
  artifact: {
    version: "1.0.0",
    commit: "a".repeat(40),
    targetName: "linux-armv7-glibc",
    target: {
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcMinVersion: "2.28",
      nodeModulesAbi: "115",
    },
    url: "https://example.test/a.tar.gz",
    format: "tar.gz",
    size: 1,
    expandedSize: 1,
    maxPreparedSize: 1,
    maxPreparedFiles: 1,
    fileCount: 1,
    sha256: "b".repeat(64),
  },
  metadata: {
    metadataVersion: 1,
    channel: "stable",
    payloadSha256: "c".repeat(64),
    publishedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-02-01T00:00:00.000Z",
  },
} as const;
const receipt = {
  id: "abcdefghijklmnop",
  userId: 42,
  chatId: 43,
  kind: "workflow-return",
  sessionToken: null,
  status: "pending",
  expiresAt: new Date("2030-01-02T00:00:00.000Z"),
  payload: {
    workflow: "ota-update",
    phase: "cancellable",
    originSource: "natural-parent",
    origin: { kind: "admin-system" },
  },
} as const;

describe("UpdateHandler exact OTA workflow", () => {
  it("checks once, marks the receipt running, and launches the exact displayed identity", async () => {
    const events: string[] = [];
    const update = {
      check: vi.fn(async () => ({
        kind: "available",
        installed: checked.artifact,
        available: checked,
      })),
      launch: vi.fn(async (input) => {
        events.push("launch");
        expect(input.checked).toBe(checked);
        return {
          kind: "started",
          commit: checked.artifact.commit,
          operationId: "AAAAAAAAAAAAAAAAAAAAAA",
        };
      }),
    };
    const workflows = {
      begin: vi.fn(async () => receipt),
      markRunning: vi.fn(async () => {
        events.push("running");
        return true;
      }),
    };
    const handler = new UpdateHandler(
      update as never,
      { adminOnly: vi.fn() } as never,
      workflows as never,
    );
    const commands: Record<string, (ctx: never) => Promise<void>> = {};
    handler.register({
      command: vi.fn((name, _guard, fn) => {
        commands[name] = fn;
      }),
    } as never);
    const ctx = {
      from: { id: 42 },
      chat: { id: 43, type: "private" },
      localeState: { catalog: catalogFor("en") },
      reply: vi.fn(async () => undefined),
    };

    await commands.update(ctx as never);

    expect(workflows.begin).toHaveBeenCalledWith(ctx, "ota-update", {
      source: "natural-parent",
    });
    expect(events).toEqual(["running", "launch"]);
    expect(update.launch).toHaveBeenCalledWith({
      checked,
      userId: 42,
      chatId: 43,
      workflowReceiptId: receipt.id,
    });
  });

  it("maps a typed discovery failure without opening a workflow", async () => {
    const update = {
      check: vi.fn(async () => ({
        kind: "failure",
        failure: { code: "signature-invalid" },
      })),
      launch: vi.fn(),
    };
    const workflows = { begin: vi.fn(), markRunning: vi.fn() };
    const handler = new UpdateHandler(
      update as never,
      { adminOnly: vi.fn() } as never,
      workflows as never,
    );
    const commands: Record<string, (ctx: never) => Promise<void>> = {};
    handler.register({
      command: vi.fn((name, _guard, fn) => {
        commands[name] = fn;
      }),
    } as never);
    const catalog = catalogFor("en");
    const ctx = {
      localeState: { catalog },
      reply: vi.fn(async () => undefined),
    };

    await commands.update(ctx as never);

    expect(ctx.reply).toHaveBeenLastCalledWith(
      catalog.ota.operationFailure("signature-invalid"),
    );
    expect(workflows.begin).not.toHaveBeenCalled();
  });
});
