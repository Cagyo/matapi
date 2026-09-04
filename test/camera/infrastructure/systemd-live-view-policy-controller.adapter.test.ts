import { describe, expect, it, vi } from "vitest";

import { SystemdLiveViewPolicyControllerAdapter } from "../../../src/camera/infrastructure/systemd-live-view-policy-controller.adapter";

describe("SystemdLiveViewPolicyControllerAdapter", () => {
  it("starts the one fixed applier unit once without a shell", async () => {
    const execFile = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error | null) => void,
      ) => callback(null),
    );

    await new SystemdLiveViewPolicyControllerAdapter(execFile).start();

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/sudo",
      [
        "-n",
        "/bin/systemctl",
        "start",
        "--no-block",
        "homeworker-live-view-policy-apply.service",
      ],
      expect.objectContaining({ shell: false, cwd: "/", timeout: 15_000 }),
      expect.any(Function),
    );
  });

  it("rejects when the fixed execFile callback reports failure", async () => {
    const failure = new Error("systemctl failed");
    const execFile = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error | null) => void,
      ) => callback(failure),
    );

    await expect(
      new SystemdLiveViewPolicyControllerAdapter(execFile).start(),
    ).rejects.toBe(failure);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
