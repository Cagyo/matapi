import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { activateOperation } from "../../../installer/ota-activate.mjs";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("root OTA activation helper assets", () => {
  it.each(["", "short", "AbCdEfGhIjKlMnOpQrStU!", "AAAAAAAAAAAAAAAAAAAAAB"])(
    "rejects a non-canonical operation ID %j before filesystem or PM2 access",
    async (operationId) => {
      await expect(activateOperation(operationId)).rejects.toMatchObject({
        code: "maintenance-required",
      });
    },
  );

  it("fails closed when the root-owned operation projection is unavailable", async () => {
    await expect(
      activateOperation("AbCdEfGhIjKlMnOpQrStUw"),
    ).rejects.toMatchObject({ code: "maintenance-required" });
  });

  it("uses fixed paths and never imports candidate application code", () => {
    const helper = read("installer/ota-activate.mjs");
    expect(helper).toContain('const INSTALL_ROOT = "/opt/home-worker"');
    expect(helper).toContain(
      'const JOURNAL_ROOT = "/opt/home-worker/shared/update"',
    );
    expect(helper).toContain(
      'const READY_PATH = "/run/home-worker/ready.json"',
    );
    expect(helper).toContain("await assertRootProjection(operationId");
    expect(helper).not.toMatch(/import\(.+candidate|require\(.+candidate/);
    expect(helper).not.toContain('join(candidate.path, "ecosystem.config.js")');
    expect(helper).toContain('"/usr/lib/home-worker/ecosystem.config.cjs"');
    expect(helper).not.toContain("process.env.HOME_WORKER_INSTALL_DIR");
  });

  it("keeps migration, durable phases, links, and health in the required order", () => {
    const helper = read("installer/ota-activate.mjs");
    const migration = helper.indexOf("migrate.entry.js");
    const activating = helper.indexOf(
      'transitionJournal(selected, "activating"',
    );
    const current = helper.lastIndexOf('atomicLink("current"');
    const activated = helper.indexOf('transitionJournal(selected, "activated"');
    const health = helper.indexOf("await waitForHealth(operationId");
    const knownGood = helper.indexOf("const knownGood = await writeKnownGood(");
    const healthy = helper.indexOf('transitionJournal(selected, "healthy"');
    const previous = helper.lastIndexOf('atomicLink("previous"');

    expect(migration).toBeLessThan(activating);
    expect(activating).toBeLessThan(current);
    expect(current).toBeLessThan(activated);
    expect(activated).toBeLessThan(health);
    expect(health).toBeLessThan(knownGood);
    expect(knownGood).toBeLessThan(healthy);
    expect(healthy).toBeLessThan(previous);
  });

  it("starts as root before PM2 and receives only a canonical operation ID", () => {
    const unit = read("systemd/home-worker-ota-activate@.service");
    expect(unit).toContain("User=root");
    expect(unit).toContain(
      "ConditionPathExists=/opt/home-worker/shared/update",
    );
    expect(unit).toContain(
      "ExecStart=/usr/bin/node /usr/lib/home-worker/ota-activate.mjs %i",
    );
    expect(unit).toContain("TimeoutStartSec=3min");
  });

  it("installs root-owned activation assets and separates the protected projection directory", () => {
    const install = read("scripts/install.sh");
    const tmpfiles = read("systemd/home-worker-ota-tmpfiles.conf");

    expect(install).toContain("installer/ota-activate.mjs");
    expect(install).toContain("home-worker-ota-activate@.service");
    expect(install).toContain("/usr/lib/home-worker/ecosystem.config.cjs");
    expect(tmpfiles).toContain("d /run/home-worker 1770 root homeworker");
    expect(tmpfiles).toContain("d /run/home-worker/activate 0700 root root");
  });

  it("surfaces restored-process restart failure as rollback_failed", () => {
    const helper = read("installer/ota-activate.mjs");

    expect(helper).toContain('transitionJournal(selected, "rollback_failed"');
    expect(helper).not.toContain(".catch(() => undefined);\n    throw error;");
  });

  it("replaces the unauthenticated legacy rollback script", () => {
    const rollback = read("scripts/rollback.sh");
    expect(rollback).toContain("authenticated maintenance");
    expect(rollback).not.toContain("git reset");
    expect(rollback).not.toContain("tar -x");
  });
});
