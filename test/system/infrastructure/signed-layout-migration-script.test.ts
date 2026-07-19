import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path);
      const nameFromRoot = relative(root, path).split("\\").join("/");
      if (info.isDirectory()) {
        hash.update(`D\0${nameFromRoot}\0${info.mode & 0o777}\n`);
        visit(path);
      } else if (info.isFile()) {
        hash.update(
          `F\0${nameFromRoot}\0${info.mode & 0o777}\0${info.size}\0${sha256(readFileSync(path))}\n`,
        );
      } else {
        throw new Error("fixture tree must contain regular files only");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture(
  options: { legacy?: boolean; pollingEnabled?: boolean } = { legacy: true },
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "home-worker-migrate-")),
  );
  roots.push(root);
  const inputs = join(root, "inputs");
  const bin = join(root, "bin");
  const installRoot = join(root, "opt/home-worker");
  const source = join(root, "baseline-source");
  const calls = join(root, "external-calls.log");
  mkdirSync(join(source, "dist"), { recursive: true });
  mkdirSync(inputs, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "var/lib/home-worker"), { recursive: true });
  mkdirSync(join(root, "opt"), { recursive: true });
  writeFileSync(join(source, "package.json"), '{"name":"home-worker"}\n');
  writeFileSync(join(source, "dist/main.js"), "baseline\n");
  writeFileSync(join(source, "ecosystem.config.js"), "module.exports = {};\n");

  const archive = join(inputs, "baseline.tar.gz");
  const tar = spawnSync("tar", ["-czf", archive, "-C", source, "."]);
  if (tar.status !== 0) throw new Error("failed to create fixture archive");
  const archiveBytes = readFileSync(archive);
  const archiveInfo = statSync(archive);
  const policy = {
    feedUrl:
      "https://updates.example.test/home-worker/stable/linux-armv7-glibc/update-envelope.json",
    channel: "stable",
    target: {
      targetName: "linux-armv7-glibc",
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcVersion: "2.36",
      nodeModulesAbi: "115",
    },
    runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
    limits: {
      maxArtifactBytes: 10_000_000,
      maxExpandedBytes: 20_000_000,
      maxPreparedBytes: 30_000_000,
      maxPreparedFiles: 10_000,
      maxFiles: 1_000,
    },
  };
  const policyPayload = { schemaVersion: 1, policy };
  const policyDocument = {
    ...policyPayload,
    checksum: sha256(JSON.stringify(policyPayload)),
  };
  const policyBytes = Buffer.from(JSON.stringify(policyDocument));
  writeFileSync(join(inputs, "ota-policy.json"), policyBytes);

  const pair = generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(join(inputs, "active.pem"), publicPem);
  const keyId = sha256(pair.publicKey.export({ type: "spki", format: "der" }));
  writeFileSync(join(inputs, "active.sha256"), `${keyId}\n`);
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      release: `1.0.0-${sha256(archiveBytes)}`,
      channel: "stable",
      target: {
        targetName: "linux-armv7-glibc",
        platform: "linux",
        arch: "arm",
        libc: "glibc",
        libcMinVersion: "2.28",
        nodeModulesAbi: "115",
      },
      runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
      policySha256: sha256(policyBytes),
      artifact: {
        sha256: sha256(archiveBytes),
        size: archiveInfo.size,
        expandedSize: 1_000_000,
        fileCount: 3,
        treeSha256: treeDigest(source),
        requiredReserveBytes: 2_000_000,
        requiredReserveInodes: 100,
      },
    }),
  );
  writeFileSync(
    join(inputs, "baseline-envelope.json"),
    JSON.stringify({
      payload: payload.toString("base64"),
      signatures: [
        {
          keyId,
          signature: sign(null, payload, pair.privateKey).toString("base64"),
        },
      ],
    }),
  );

  for (const command of ["pm2", "systemctl", "chattr"]) {
    const disabledPolling =
      command === "systemctl" && options.pollingEnabled === false
        ? 'if [[ "$1" == "is-enabled" ]]; then exit 1; fi\n'
        : "";
    executable(
      join(bin, command),
      `printf '${command}:%s\\n' "$*" >> '${calls}'\n${disabledPolling}`,
    );
  }
  if (options.legacy !== false) {
    mkdirSync(join(installRoot, "dist"), { recursive: true });
    mkdirSync(join(installRoot, "data"));
    writeFileSync(join(installRoot, "package.json"), '{"legacy":true}\n');
    writeFileSync(join(installRoot, "dist/main.js"), "legacy\n");
    writeFileSync(join(installRoot, "data/worker.db"), "legacy-db\n");
    writeFileSync(join(installRoot, ".env"), "TELEGRAM_BOT_TOKEN=secret\n");
  }
  return { root, inputs, bin, installRoot, calls };
}

function run(
  setup: ReturnType<typeof fixture>,
  args: string[],
  failure?: string,
) {
  return spawnSync(
    "bash",
    [resolve("scripts/migrate-to-signed-ota.sh"), ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME_WORKER_TEST_MODE: "1",
        HOME_WORKER_TEST_ROOT: setup.root,
        HOME_WORKER_TEST_BIN: setup.bin,
        HOME_WORKER_TEST_TARGET_ARCH: "arm",
        HOME_WORKER_TEST_NODE_MAJOR: "20",
        HOME_WORKER_TEST_NODE_ABI: "115",
        HOME_WORKER_TEST_LIBC_VERSION: "2.36",
        ...(failure ? { HOME_WORKER_TEST_FAIL_AT: failure } : {}),
      },
    },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("signed layout migration gate", () => {
  it("requires an explicit fresh or confirmed migrate mode", () => {
    const setup = fixture();

    expect(run(setup, []).status).toBe(64);
    expect(run(setup, ["--migrate"]).status).toBe(64);
    expect(run(setup, ["--fresh", "--confirm"]).status).toBe(64);
  });

  it("ships no Git, checkout-copy, network, or unsigned fallback", () => {
    const scripts = ["scripts/install.sh", "scripts/migrate-to-signed-ota.sh"]
      .map((path) => readFileSync(resolve(path), "utf8"))
      .join("\n");

    expect(scripts).not.toMatch(
      /\bgit\s+(?:clone|fetch|pull|reset)\b|\b(?:curl|wget|rsync)\b/,
    );
    expect(scripts).not.toMatch(/HOME_WORKER_(?:REPO|RELEASE_URL)/);
    expect(scripts).not.toMatch(/cp\s+-a\s+[^\n]*\/\.\s/);
  });

  it("rejects test-mode roots outside the canonical temporary prefixes", () => {
    const setup = fixture();
    const result = spawnSync(
      "bash",
      [resolve("scripts/migrate-to-signed-ota.sh"), "--migrate", "--confirm"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME_WORKER_TEST_MODE: "1",
          HOME_WORKER_TEST_ROOT: "/",
          HOME_WORKER_TEST_BIN: setup.bin,
        },
      },
    );

    expect(result.status).toBe(64);
    expect(() => readFileSync(setup.calls, "utf8")).toThrow();
  });

  it("fails before any protected mutation when authenticated inputs are absent", () => {
    const setup = fixture();
    rmSync(join(setup.inputs, "baseline-envelope.json"));
    const before = readFileSync(
      join(setup.installRoot, "data/worker.db"),
      "utf8",
    );

    const result = run(setup, ["--migrate", "--confirm"]);

    expect(result.status).toBe(75);
    expect(`${result.stdout}${result.stderr}`).toContain("baseline");
    expect(
      readFileSync(join(setup.installRoot, "data/worker.db"), "utf8"),
    ).toBe(before);
    expect(() => readFileSync(setup.calls, "utf8")).toThrow();
  });

  it("refuses an unknown existing layout without external mutation", () => {
    const setup = fixture();
    writeFileSync(join(setup.installRoot, "unknown"), "state\n");

    const result = run(setup, ["--migrate", "--confirm"]);

    expect(result.status).toBe(75);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "unknown existing layout",
    );
    expect(() => readFileSync(setup.calls, "utf8")).toThrow();
  });

  it("rejects a tampered signed envelope before external mutation", () => {
    const setup = fixture();
    const envelopePath = join(setup.inputs, "baseline-envelope.json");
    const envelope = JSON.parse(readFileSync(envelopePath, "utf8"));
    envelope.signatures[0].signature = Buffer.alloc(64).toString("base64");
    writeFileSync(envelopePath, JSON.stringify(envelope));

    const result = run(setup, ["--migrate", "--confirm"]);

    expect(result.status).toBe(75);
    expect(() => readFileSync(setup.calls, "utf8")).toThrow();
    expect(
      readFileSync(join(setup.installRoot, "data/worker.db"), "utf8"),
    ).toBe("legacy-db\n");
  });

  it.each(["preflight", "backup", "stage", "swap", "pm2-stop", "pm2-start"])(
    "restores the exact legacy layout after injected %s failure",
    (point) => {
      const setup = fixture();

      const result = run(setup, ["--migrate", "--confirm"], point);

      expect(result.status).toBe(75);
      expect(
        readFileSync(join(setup.installRoot, "dist/main.js"), "utf8"),
      ).toBe("legacy\n");
      expect(
        readFileSync(join(setup.installRoot, "data/worker.db"), "utf8"),
      ).toBe("legacy-db\n");
      expect(lstatSync(setup.installRoot).isDirectory()).toBe(true);
      expect(
        readdirSync(join(setup.root, "var/lib/home-worker"), {
          withFileTypes: true,
        }).filter((entry) => entry.name.startsWith("migration-")),
      ).toHaveLength(0);
      if (["backup", "swap", "pm2-stop", "pm2-start"].includes(point)) {
        const calls = readFileSync(setup.calls, "utf8");
        expect(calls).toContain("systemctl:disable home-worker-update.timer");
        expect(calls).toContain("systemctl:enable home-worker-update.timer");
        expect(calls).toContain("pm2:start ecosystem.config.js");
      }
    },
  );

  it("executes the signed-layout swap only under the canonical test root", () => {
    const setup = fixture();

    const result = run(setup, ["--migrate", "--confirm"]);

    expect(result.status).toBe(0);
    expect(lstatSync(join(setup.installRoot, "current")).isSymbolicLink()).toBe(
      true,
    );
    expect(
      readFileSync(join(setup.installRoot, "current/dist/main.js"), "utf8"),
    ).toBe("baseline\n");
    expect(
      readFileSync(join(setup.installRoot, "data/worker.db"), "utf8"),
    ).toBe("legacy-db\n");
  });

  it("restores an initially disabled polling timer after failure", () => {
    const setup = fixture({ pollingEnabled: false });

    const result = run(setup, ["--migrate", "--confirm"], "backup");

    expect(result.status).toBe(75);
    const calls = readFileSync(setup.calls, "utf8");
    expect(calls).not.toContain("systemctl:enable home-worker-update.timer");
    expect(
      calls.match(/systemctl:disable home-worker-update\.timer/g),
    ).toHaveLength(2);
  });

  it("supports a guarded fresh layout only when the install root is absent", () => {
    const setup = fixture({ legacy: false });

    const result = run(setup, ["--fresh"]);

    expect(result.status).toBe(0);
    expect(
      readFileSync(join(setup.installRoot, "current/dist/main.js"), "utf8"),
    ).toBe("baseline\n");
  });
});
