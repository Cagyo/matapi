import { execFile as childExecFile } from "node:child_process";

import type { LiveViewPolicyControllerPort } from "../domain/ports/live-view-policy-controller.port";

const UNIT = "homeworker-live-view-policy-apply.service";

type ExecFile = (
  file: string,
  args: readonly string[],
  options: {
    shell: false;
    cwd: "/";
    timeout: number;
    env: Record<string, string>;
  },
  callback: (error: Error | null) => void,
) => unknown;

export class SystemdLiveViewPolicyControllerAdapter implements LiveViewPolicyControllerPort {
  constructor(private readonly execFile: ExecFile = childExecFile) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.execFile(
        "/usr/bin/sudo",
        ["-n", "/bin/systemctl", "start", "--no-block", UNIT],
        {
          shell: false,
          cwd: "/",
          timeout: 15_000,
          env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
        },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }
}
