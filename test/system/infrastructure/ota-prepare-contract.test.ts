import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("OTA dependency preparation assets", () => {
  const unit = read("systemd/home-worker-ota-prepare@.service");
  const activator = read("installer/ota-prepare-activate");
  const sudoers = read("systemd/home-worker-ota-prepare.sudoers");
  const tmpfiles = read("systemd/home-worker-ota-tmpfiles.conf");
  const migration = read("scripts/migrate-to-signed-ota.sh");
  const preparer = read("installer/ota-prepare.mjs");

  it("pins the required systemd sandbox and whole-cgroup lifecycle", () => {
    expect(unit).toContain("User=homeworker");
    expect(unit).toContain("PrivateNetwork=yes");
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("ProtectHome=yes");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("MemoryMax=512M");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain(
      "ExecStart=/usr/bin/flock --no-fork --exclusive /run/home-worker/ota-prepare.lock",
    );
  });

  it("makes only the operation candidate and private temp writable", () => {
    const writable = unit
      .split("\n")
      .filter((line) => line.startsWith("ReadWritePaths="));

    expect(writable).toEqual([
      "ReadWritePaths=/run/home-worker/prepare/%i/candidate /run/home-worker/prepare/%i/tmp",
    ]);
    expect(unit).toContain("InaccessiblePaths=/opt/home-worker/shared");
    expect(unit).toContain("InaccessiblePaths=/opt/home-worker/data");
    expect(unit).toContain("InaccessiblePaths=-/opt/home-worker/.env");
    expect(unit).toContain("InaccessiblePaths=/home/homeworker/.pm2");
    expect(unit).not.toMatch(
      /ReadWritePaths=.*\/opt\/home-worker\/releases(?:\s|$)/,
    );
  });

  it("starts only the exact templated preparation unit for a canonical ID", () => {
    expect(activator).toContain("^[A-Za-z0-9_-]{21}[AQgw]$");
    expect(activator).toContain(
      'exec /bin/systemctl start -- "home-worker-ota-prepare@${operation_id}.service"',
    );
    expect(activator).not.toMatch(/\b(?:ln|mv|rename|chown)\b/);
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

  it("contains no release adoption or persistent-link mutation authority", () => {
    const preparationAssets = `${preparer}\n${activator}\n${unit}`;
    expect(preparationAssets).not.toMatch(
      /\/opt\/home-worker\/(?:current|previous)/,
    );
    expect(preparationAssets).not.toMatch(
      /\b(?:symlink|rename|readlink|ln|mv)\s*\(/,
    );
  });

  it("keeps root-owned preparation assets dormant until baseline adoption is enabled", () => {
    expect(tmpfiles).toContain("d /run/home-worker/prepare 0711 root root - -");
    expect(tmpfiles).toContain(
      "f /run/home-worker/ota-prepare.lock 0644 root root - -",
    );
    expect(migration).toContain("production signed-layout adoption remains disabled");
    expect(migration).not.toMatch(/ota-prepare@|ota-prepare\.sudoers|installer\/ota-prepare/);
  });
});
