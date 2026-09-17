import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const installFeature = readFileSync(
  resolve("scripts/install-feature.sh"),
  "utf8",
);

interface RoutineOptions {
  applierStatus?: number;
  aptStatus?: number;
  credentialsStatus?: number;
}

/** Run the production privileged routine with only operating-system commands stubbed. */
function routineHarness(options: RoutineOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "rtsp-privileged-routine-"));
  const bin = join(root, "bin");
  const bundle = join(root, "bundle");
  const systemd = join(root, "systemd");
  const polkit = join(root, "polkit");
  const tmpfiles = join(root, "tmpfiles");
  const app = join(root, "app");
  const etc = join(root, "etc");
  const log = join(root, "commands.log");
  for (const path of [
    bin,
    join(bundle, "systemd"),
    systemd,
    polkit,
    tmpfiles,
    app,
    join(etc, "ca"),
  ]) {
    mkdirSync(path, { recursive: true });
  }

  const envPath = join(app, ".env");
  writeFileSync(envPath, "PRIVATE_VALUE=never-log-me\n", { mode: 0o600 });
  chmodSync(envPath, 0o600);
  for (const name of [
    "homeworker-ffmpeg-stream@.service",
    "homeworker-stream-net.service",
    "homeworker-stream-systemd.rules",
  ]) {
    writeFileSync(join(bundle, "systemd", name), "@HOME_WORKER_USER@\n");
  }
  writeFileSync(
    join(bundle, "live-stream-ffmpeg-runner"),
    "#!/bin/sh\nexit 0\n",
  );
  chmodSync(join(bundle, "live-stream-ffmpeg-runner"), 0o755);
  writeFileSync(
    join(bundle, "live-view-policy-applier"),
    `#!/bin/sh
[ "\${HOME_WORKER_TEST_ELEVATED:-0}" = "1" ] || exit 91
printf 'elevated-applier %s\\n' "$*" >> ${JSON.stringify(log)}
exit ${options.applierStatus ?? 0}
`,
  );
  chmodSync(join(bundle, "live-view-policy-applier"), 0o755);
  writeFileSync(
    join(bundle, "feature-installer"),
    `#!/bin/sh
[ "\${HOME_WORKER_TEST_ELEVATED:-0}" = "1" ] || exit 91
printf 'elevated-feature-installer %s\\n' "$*" >> ${JSON.stringify(log)}
exit ${options.credentialsStatus ?? 0}
`,
  );
  chmodSync(join(bundle, "feature-installer"), 0o755);

  writeFileSync(join(bin, "getent"), "#!/bin/sh\nexit 0\n");
  writeFileSync(
    join(bin, "id"),
    '#!/bin/sh\nif [ "${1:-}" = "-u" ]; then exec /usr/bin/id -u; fi\nexit 0\n',
  );
  writeFileSync(
    join(bin, "apt-get"),
    `#!/bin/sh\nprintf 'apt-get %s\\n' "$*" >> ${JSON.stringify(log)}\nexit ${options.aptStatus ?? 0}\n`,
  );
  writeFileSync(
    join(bin, "install"),
    `#!/bin/bash
args=()
while (($#)); do
  case "$1" in
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/install "${"${args[@]}"}"
`,
  );
  writeFileSync(
    join(bin, "sudo"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1" in
  apt-get) shift; exec ${JSON.stringify(join(bin, "apt-get"))} "$@" ;;
  install) shift; exec ${JSON.stringify(join(bin, "install"))} "$@" ;;
  rm) shift; exec /bin/rm "$@" ;;
  ${JSON.stringify(join(bundle, "feature-installer"))}) shift; HOME_WORKER_TEST_ELEVATED=1 exec ${JSON.stringify(join(bundle, "feature-installer"))} "$@" ;;
  ${JSON.stringify(join(bundle, "live-view-policy-applier"))}) shift; HOME_WORKER_TEST_ELEVATED=1 exec ${JSON.stringify(join(bundle, "live-view-policy-applier"))} "$@" ;;
  *) exit 0 ;;
esac
`,
  );
  for (const name of ["getent", "id", "apt-get", "install", "sudo"]) {
    chmodSync(join(bin, name), 0o755);
  }

  const prelude = installFeature
    .split(/^case "\$FEATURE" in/m)[0]
    .replaceAll("/usr/bin/sudo", join(bin, "sudo"))
    .replaceAll("/usr/lib/home-worker", bundle)
    .replaceAll("/opt/home-worker", app)
    .replaceAll("/etc/home-worker", etc)
    .replaceAll("/etc/systemd/system", systemd)
    .replaceAll("/etc/polkit-1/rules.d", polkit)
    .replaceAll("/etc/tmpfiles.d", tmpfiles);
  const script = join(root, "run.sh");
  writeFileSync(
    script,
    `#!/bin/bash
set -euo pipefail
export PATH=${JSON.stringify(bin)}:$PATH
HOME_WORKER_PRIVILEGED=1
${prelude}
install_rtsp_runtime
`,
  );
  chmodSync(script, 0o755);

  return {
    app,
    etc,
    log,
    root,
    run: () =>
      execFileSync("bash", [script], { encoding: "utf8", stdio: "pipe" }),
  };
}

function routineExitStatus(run: () => unknown): number {
  try {
    run();
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
  throw new Error("the privileged routine unexpectedly succeeded");
}

describe("restricted RTSP runtime installation", () => {
  const install = readFileSync(resolve("scripts/install.sh"), "utf8");
  const deps = readFileSync(resolve("config/system-deps.yml"), "utf8");

  it("installs the restricted dependencies and root-owned runtime assets without broad sudoers", () => {
    expect(deps).toMatch(
      /rtsp:[\s\S]*- ffmpeg[\s\S]*- nftables[\s\S]*- cloudflared/,
    );
    expect(installFeature).toContain(
      "apt_get install -y ffmpeg nftables polkitd pkexec",
    );
    expect(installFeature).not.toMatch(/apt_get install[^\n]*policykit-1/);
    expect(installFeature).toContain("homeworker-stream-net.service");
    expect(installFeature).toContain("homeworker-ffmpeg-stream@.service");
    expect(installFeature).toContain("live-stream-ffmpeg-runner");
    expect(installFeature).toContain("homeworker-stream-systemd.rules");
    expect(installFeature).toContain(
      "d /run/home-worker/live-source-probe 0700 $USER $USER",
    );
    expect(installFeature).not.toMatch(
      /sudoers[\s\S]*homeworker-ffmpeg-stream/,
    );
    expect(installFeature).not.toMatch(
      /NOPASSWD:[^\n]*(?:nft|homeworker-ffmpeg|homeworker-stream-net)/,
    );
    expect(install).toContain("['digital','uart','zigbee','motion','rtsp']");
  });

  it("creates a locked no-login no-home stream identity and keeps only credential env authority", () => {
    expect(installFeature).toMatch(
      /useradd[^\n]*(?:--system|-r)[^\n]*(?:--no-create-home|-M)/,
    );
    expect(installFeature).toContain("/usr/sbin/nologin");
    expect(installFeature).toContain('usermod -L "$stream_user"');
    expect(installFeature).not.toContain("$STREAM_USER");
    expect(installFeature).not.toContain("LIVE_STREAM_ENABLED");
    expect(installFeature).not.toContain("RTSP_ALLOWED_CIDRS");
    expect(installFeature).not.toContain("RTSP_POLICY_DIGEST");
    expect(installFeature).not.toContain("live-stream-policy-inspector");
    expect(installFeature).not.toContain(".staged");
    expect(readFileSync(resolve(".env.example"), "utf8")).toMatch(
      /^RTSP_CREDENTIALS_KEY=\s*$/m,
    );
  });

  it("provisions credentials and bootstraps through elevation after assets and daemon reload", () => {
    const harness = routineHarness();
    try {
      expect(() => harness.run()).not.toThrow();
      const commands = readFileSync(harness.log, "utf8");
      expect(commands).toContain("systemctl daemon-reload");
      expect(commands).toContain(
        "systemctl enable homeworker-stream-net.service",
      );
      expect(commands).toContain(
        "elevated-feature-installer --provision-rtsp-credentials",
      );
      expect(commands).toContain("elevated-applier --bootstrap-rtsp");
      expect(
        commands.indexOf(
          "elevated-feature-installer --provision-rtsp-credentials",
        ),
      ).toBeLessThan(commands.indexOf("apt-get"));
      expect(commands.indexOf("systemctl daemon-reload")).toBeLessThan(
        commands.indexOf("elevated-applier --bootstrap-rtsp"),
      );
      expect(existsSync(join(harness.etc, "live-stream-policy.json"))).toBe(
        false,
      );
      expect(commands).not.toContain("never-log-me");
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  it("maps package and policy-applier failures to their reserved statuses", () => {
    const packages = routineHarness({ aptStatus: 100 });
    try {
      expect(routineExitStatus(packages.run)).toBe(22);
      expect(readFileSync(packages.log, "utf8")).toContain("apt-get");
      expect(readFileSync(packages.log, "utf8")).not.toContain(
        "elevated-applier",
      );
    } finally {
      rmSync(packages.root, { recursive: true, force: true });
    }

    const bootstrap = routineHarness({ applierStatus: 3 });
    try {
      expect(routineExitStatus(bootstrap.run)).toBe(23);
      expect(readFileSync(bootstrap.log, "utf8")).toContain(
        "elevated-applier --bootstrap-rtsp",
      );
    } finally {
      rmSync(bootstrap.root, { recursive: true, force: true });
    }
  });

  it("ships hardened bounded units and selected-instance Polkit authorization", () => {
    const unit = readFileSync(
      resolve("systemd/homeworker-ffmpeg-stream@.service"),
      "utf8",
    );
    expect(unit).toContain("User=homeworker-stream");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("PrivateTmp=yes");
    expect(unit).toContain("ProtectHome=yes");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain(
      "InaccessiblePaths=-/opt/home-worker/.env -/opt/home-worker/data",
    );
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    expect(unit).not.toContain("EnvironmentFile=");

    const helperUnit = readFileSync(
      resolve("systemd/homeworker-stream-net.service"),
      "utf8",
    );
    expect(helperUnit).not.toContain("CAP_DAC_OVERRIDE");
    expect(helperUnit).toContain(
      "ExecStopPost=-/usr/sbin/nft delete table inet homeworker_stream",
    );
    expect(helperUnit).toContain("Type=notify");
    expect(helperUnit).toContain("NotifyAccess=main");

    const rule = readFileSync(
      resolve("systemd/homeworker-stream-systemd.rules"),
      "utf8",
    );
    let callback:
      | ((
          action: { id: string; lookup(key: string): string },
          subject: { user: string },
        ) => unknown)
      | undefined;
    const polkit = {
      Result: { YES: "YES" },
      addRule: (value: typeof callback) => {
        callback = value;
      },
    };
    runInNewContext(rule.replaceAll("@HOME_WORKER_USER@", "homeworker"), {
      polkit,
    });
    const evaluate = (unitName: string, verb: string) =>
      callback?.(
        {
          id: "org.freedesktop.systemd1.manage-units",
          lookup: (key) => (key === "unit" ? unitName : verb),
        },
        { user: "homeworker" },
      );
    const uuid = "01901f4c-b7f4-4c6a-a787-3f8a442c85d2";
    expect(evaluate(`homeworker-ffmpeg-stream@${uuid}.service`, "start")).toBe(
      "YES",
    );
    expect(evaluate("ssh.service", "start")).toBeUndefined();
    expect(
      evaluate("homeworker-ffmpeg-stream@x.service", "start"),
    ).toBeUndefined();
    expect(
      evaluate(`homeworker-ffmpeg-stream@${uuid}.service`, "restart"),
    ).toBeUndefined();
  });

  it("has syntactically valid shell and Python runtime assets", () => {
    execFileSync("bash", ["-n", resolve("scripts/install-feature.sh")]);
    execFileSync("python3", [
      "-m",
      "py_compile",
      resolve("scripts/live-stream-net-helper"),
    ]);
    execFileSync("python3", [
      "-m",
      "py_compile",
      resolve("scripts/live-stream-ffmpeg-runner"),
    ]);
    execFileSync("python3", [
      "-m",
      "py_compile",
      resolve("scripts/feature-installer.py"),
    ]);
    execFileSync("python3", [
      "-m",
      "py_compile",
      resolve("scripts/live-view-policy-applier.py"),
    ]);
  });
});
