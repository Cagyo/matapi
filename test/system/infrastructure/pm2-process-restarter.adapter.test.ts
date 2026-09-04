import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Pm2ProcessRestarter } from "../../../src/system/infrastructure/pm2-process-restarter.adapter";

function child() {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

describe("Pm2ProcessRestarter", () => {
  it("resolves and detaches only after the PM2 command closes successfully", async () => {
    const spawned = child();
    const spawn = vi.fn().mockReturnValue(spawned);
    const restarter = new Pm2ProcessRestarter(spawn as never);

    const pending = restarter.restart();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    expect(spawned.unref).not.toHaveBeenCalled();
    spawned.emit("spawn");
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(spawned.unref).not.toHaveBeenCalled();
    spawned.emit("close", 0, null);

    await expect(pending).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledWith("pm2", ["restart", "worker"], {
      detached: true,
      shell: false,
      stdio: "ignore",
    });
    expect(spawned.unref).toHaveBeenCalledOnce();
  });

  it("rejects a launch error without detaching the child", async () => {
    const spawned = child();
    const restarter = new Pm2ProcessRestarter(
      vi.fn().mockReturnValue(spawned) as never,
    );
    const failure = new Error("pm2 unavailable");

    const pending = restarter.restart();
    spawned.emit("error", failure);

    await expect(pending).rejects.toBe(failure);
    expect(spawned.unref).not.toHaveBeenCalled();
  });

  it("rejects when the PM2 command closes with a non-zero exit code", async () => {
    const spawned = child();
    const restarter = new Pm2ProcessRestarter(
      vi.fn().mockReturnValue(spawned) as never,
    );

    const pending = restarter.restart();
    spawned.emit("spawn");
    spawned.emit("close", 1, null);

    await expect(pending).rejects.toThrow("code 1");
    expect(spawned.unref).not.toHaveBeenCalled();
  });

  it("rejects when the PM2 command is terminated by a signal", async () => {
    const spawned = child();
    const restarter = new Pm2ProcessRestarter(
      vi.fn().mockReturnValue(spawned) as never,
    );

    const pending = restarter.restart();
    spawned.emit("spawn");
    spawned.emit("close", null, "SIGTERM");

    await expect(pending).rejects.toThrow("SIGTERM");
    expect(spawned.unref).not.toHaveBeenCalled();
  });
});
