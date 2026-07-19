import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("two-phase OTA dependency preparation assets", () => {
  const coordinator = read("systemd/home-worker-ota-prepare@.service");
  const fetchUnit = read("systemd/home-worker-ota-deps-fetch@.service");
  const buildUnit = read("systemd/home-worker-ota-deps-build@.service");
  const activator = read("installer/ota-prepare-activate");
  const sudoers = read("systemd/home-worker-ota-prepare.sudoers");
  const tmpfiles = read("systemd/home-worker-ota-tmpfiles.conf");
  const migration = read("scripts/migrate-to-signed-ota.sh");
  const preparer = read("installer/ota-prepare.mjs");
  const archiveInspector = read(
    "src/system/infrastructure/archive-inspector.ts",
  );

  it("holds the global lease in a root-owned network-isolated coordinator", () => {
    expect(coordinator).toContain("User=root");
    expect(coordinator).toContain("PrivateNetwork=yes");
    expect(coordinator).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(coordinator).toContain("NoNewPrivileges=yes");
    expect(coordinator).toContain("ProtectSystem=strict");
    expect(coordinator).toContain("CapabilityBoundingSet=CAP_DAC_OVERRIDE");
    expect(coordinator).toContain("AmbientCapabilities=");
    expect(archiveInspector).toContain("await mkdir(root, { mode: 0o700 })");
    expect(coordinator).toContain("KillMode=control-group");
    expect(coordinator).toContain(
      "ExecStart=/usr/bin/flock --no-fork --exclusive /run/home-worker/ota-prepare.lock /usr/bin/node /usr/lib/home-worker/ota-prepare.mjs coordinate %i",
    );
    expect(preparer).toContain(
      "home-worker-ota-deps-${phase}@${operationId}.service",
    );
  });

  it("holds the coordinator lease across bounded phases and cancellation", () => {
    expect(coordinator).toContain("TimeoutStartSec=45min");
    expect(coordinator).toContain("TimeoutStopSec=2min");
    expect(fetchUnit).toContain("TimeoutStartSec=20min");
    expect(buildUnit).toContain("TimeoutStartSec=20min");
    expect(fetchUnit).toContain("PartOf=home-worker-ota-prepare@%i.service");
    expect(buildUnit).toContain("PartOf=home-worker-ota-prepare@%i.service");
    expect(fetchUnit).toContain("BindsTo=home-worker-ota-prepare@%i.service");
    expect(buildUnit).toContain("BindsTo=home-worker-ota-prepare@%i.service");
    expect(fetchUnit).not.toContain("After=home-worker-ota-prepare@%i.service");
    expect(buildUnit).not.toContain("After=home-worker-ota-prepare@%i.service");
    expect(preparer).toContain('process.once("SIGTERM", stopBeforeRelease)');
    expect(preparer).toContain(
      'systemctlProcess(["stop", "--wait", "--", unit])',
    );
    expect(preparer).toContain("await stopping");
  });

  it("grants Internet address families only to the lifecycle-disabled fetch phase", () => {
    expect(fetchUnit).toContain("User=homeworker");
    expect(fetchUnit).toContain("PrivateNetwork=no");
    expect(fetchUnit).toContain(
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    );
    expect(fetchUnit).toContain("ota-prepare.mjs fetch %i");
    expect(fetchUnit).toContain("CapabilityBoundingSet=\n");
    expect(fetchUnit).not.toContain("CAP_DAC_OVERRIDE");
    expect(buildUnit).toContain("User=homeworker");
    expect(buildUnit).toContain("PrivateNetwork=yes");
    expect(buildUnit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(buildUnit).toContain("ota-prepare.mjs build %i");
    expect(buildUnit).toContain("CapabilityBoundingSet=\n");
    expect(buildUnit).not.toContain("CAP_DAC_OVERRIDE");
    expect(preparer).toContain(
      'YARN_ENABLE_SCRIPTS: network ? "false" : "true"',
    );
    expect(preparer).toContain(
      'YARN_ENABLE_NETWORK: network ? "true" : "false"',
    );
    expect(preparer).toContain('YARN_ENABLE_IMMUTABLE_CACHE: "false"');
    expect(preparer).toContain('YARN_CHECKSUM_BEHAVIOR: "throw"');
  });

  it("seals the public registry and strips inherited credentials, proxies, and config homes", () => {
    for (const unit of [coordinator, fetchUnit, buildUnit]) {
      expect(unit).toContain(
        "UnsetEnvironment=HOME XDG_CONFIG_HOME XDG_CACHE_HOME",
      );
      expect(unit).toContain("YARN_NPM_AUTH_TOKEN");
      expect(unit).toContain("YARN_HTTP_PROXY YARN_HTTPS_PROXY");
      expect(unit).toContain("HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY");
    }
    expect(preparer).toContain(
      '["npmRegistryServer", "https://registry.npmjs.org"]',
    );
    expect(preparer).toContain('["npmAlwaysAuth", "false"]');
    const urls = preparer.match(/https?:\/\/[^"'\s]+/gu) ?? [];
    expect(urls).toEqual([
      "https://registry.npmjs.org",
      "https://registry.npmjs.org",
    ]);
  });

  it("makes only the operation candidate and private temp writable", () => {
    for (const unit of [coordinator, fetchUnit, buildUnit]) {
      const writable = unit
        .split("\n")
        .filter((line) => line.startsWith("ReadWritePaths="));
      expect(writable).toEqual([
        "ReadWritePaths=/run/home-worker/prepare/%i/candidate /run/home-worker/prepare/%i/tmp",
      ]);
      expect(unit).toContain("InaccessiblePaths=/opt/home-worker/shared");
      expect(unit).toContain("InaccessiblePaths=/opt/home-worker/data");
      expect(unit).not.toMatch(
        /ReadWritePaths=.*\/opt\/home-worker\/releases(?:\s|$)/u,
      );
    }
  });

  it("makes only the coordinator sudo-startable for a canonical operation ID", () => {
    expect(activator).toContain("^[A-Za-z0-9_-]{21}[AQgw]$");
    expect(activator).toContain(
      'exec /bin/systemctl start -- "home-worker-ota-prepare@${operation_id}.service"',
    );
    expect(`${activator}\n${sudoers}`).not.toMatch(/ota-deps-(?:fetch|build)/u);
    expect(sudoers.trim()).toBe(
      "homeworker ALL=(root) NOPASSWD: /usr/lib/home-worker/ota-prepare-activate ^[A-Za-z0-9_-]{21}[AQgw]$",
    );
  });

  it.each(["", "short", "AbCdEfGhIjKlMnOpQrStU!", `${"A".repeat(22)}\nbad`])(
    "rejects hostile activator ID %j before calling systemd",
    (operationId) => {
      const result = spawnSync(resolve("installer/ota-prepare-activate"), [
        operationId,
      ]);
      expect(result.status).toBe(64);
    },
  );

  it("contains no release adoption or persistent pointer authority", () => {
    const preparationAssets = `${preparer}\n${activator}\n${coordinator}\n${fetchUnit}\n${buildUnit}`;
    expect(preparationAssets).not.toMatch(
      /\/opt\/home-worker\/(?:current|previous)/u,
    );
    expect(activator).not.toMatch(/\b(?:ln|mv|rename|chown)\b/u);
  });

  it("invalidates failed bind-mounted candidates without deleting the mount root", () => {
    expect(preparer).not.toContain("rm(context.candidate,");
    expect(preparer).toContain("readdir(context.candidateProjection)");
    expect(preparer).toContain("syncDirectory(context.candidateProjection)");
    expect(preparer).toContain("strictBuildSentinel(");
    expect(preparer).toContain('challenge: randomBytes(32).toString("hex")');
    expect(preparer).toContain("buildSentinelPath(context)");
  });

  it("keeps root-owned preparation assets dormant until baseline adoption is enabled", () => {
    expect(tmpfiles).toContain("d /run/home-worker/prepare 0711 root root - -");
    expect(tmpfiles).toContain(
      "f /run/home-worker/ota-prepare.lock 0644 root root - -",
    );
    expect(migration).toContain(
      "production signed-layout adoption remains disabled",
    );
    expect(migration).not.toMatch(
      /ota-prepare@|ota-prepare\.sudoers|installer\/ota-prepare/u,
    );
  });
});
