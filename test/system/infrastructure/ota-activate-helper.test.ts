import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateOperation,
  adoptCandidateTree,
  digestTree,
  verifyCandidateAuthorization,
} from "../../../installer/ota-activate.mjs";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const roots: string[] = [];
const ARTIFACT_SHA = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function keyId(publicKey: KeyObject): string {
  return createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}

function manifest() {
  return {
    schemaVersion: 1,
    metadataVersion: 42,
    channel: "stable",
    version: "1.4.2",
    commit: "0".repeat(40),
    publishedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-31T00:00:00.000Z",
    target: {
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcMinVersion: "2.28",
      nodeModulesAbi: "115",
    },
    artifact: {
      url: "https://updates.example.test/releases/1.4.2.tar.gz",
      format: "tar.gz",
      size: 1,
      expandedSize: 2,
      maxPreparedSize: 3,
      maxPreparedFiles: 4,
      fileCount: 1,
      sha256: ARTIFACT_SHA,
    },
    runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
  };
}

function signedEnvelope(pair = generateKeyPairSync("ed25519")) {
  const payload = Buffer.from(JSON.stringify(manifest()));
  return {
    pair,
    bytes: Buffer.from(
      JSON.stringify({
        payload: payload.toString("base64"),
        signatures: [
          {
            keyId: keyId(pair.publicKey),
            signature: sign(null, payload, pair.privateKey).toString("base64"),
          },
        ],
      }),
    ),
  };
}

function marker(envelope: Buffer) {
  const release = manifest();
  return {
    schemaVersion: 1,
    artifact: {
      version: release.version,
      commit: release.commit,
      targetName: "linux-armv7-glibc",
      target: release.target,
      ...release.artifact,
    },
    metadata: {
      metadataVersion: release.metadataVersion,
      channel: release.channel,
      payloadSha256: createHash("sha256")
        .update(Buffer.from(JSON.stringify(release)))
        .digest("hex"),
      publishedAt: release.publishedAt,
      expiresAt: release.expiresAt,
    },
    envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
    preparedTreeSha256: "b".repeat(64),
    writtenAt: "2030-01-15T00:00:00.000Z",
  };
}

async function trustFixture(
  scope: "active" | "retired",
  pair: ReturnType<typeof generateKeyPairSync>,
) {
  const root = await mkdtemp(resolve(tmpdir(), "ota-activate-trust-"));
  roots.push(root);
  await mkdir(resolve(root, "active"));
  await mkdir(resolve(root, "retired"));
  writeFileSync(
    resolve(root, scope, "publisher.pem"),
    pair.publicKey.export({ format: "pem", type: "spki" }),
  );
  return root;
}

function checkedIdentity(envelope: Buffer) {
  const value = marker(envelope);
  return { artifact: value.artifact, metadata: value.metadata };
}

describe("root OTA activation helper assets", () => {
  it("requires an active-key Ed25519 signature for update activation", async () => {
    const signed = signedEnvelope();
    const trustRoot = await trustFixture("active", signed.pair);

    expect(
      await verifyCandidateAuthorization(
        { kind: "update", expected: checkedIdentity(signed.bytes) },
        marker(signed.bytes),
        signed.bytes,
        null,
        { trustRoot, now: new Date("2030-01-15T00:00:00.000Z") },
      ),
    ).toMatchObject({ artifactSha256: ARTIFACT_SHA });

    const untrusted = signedEnvelope();
    await expect(
      verifyCandidateAuthorization(
        { kind: "update", expected: checkedIdentity(untrusted.bytes) },
        marker(untrusted.bytes),
        untrusted.bytes,
        null,
        { trustRoot, now: new Date("2030-01-15T00:00:00.000Z") },
      ),
    ).rejects.toMatchObject({ code: "maintenance-required" });
  });

  it("permits a retired signature only for an exact known-good rollback", async () => {
    const signed = signedEnvelope();
    const trustRoot = await trustFixture("retired", signed.pair);
    const artifact = marker(signed.bytes);
    const knownGood = {
      schemaVersion: 1,
      operationId: "BBBBBBBBBBBBBBBBBBBBBA",
      artifactSha256: ARTIFACT_SHA,
      metadataSha256: artifact.metadata.payloadSha256,
      preparedTreeSha256: artifact.preparedTreeSha256,
      activatedAt: "2030-01-10T00:00:00.000Z",
    };

    await expect(
      verifyCandidateAuthorization(
        { kind: "rollback", expected: null },
        artifact,
        signed.bytes,
        knownGood,
        { trustRoot, now: new Date("2030-02-15T00:00:00.000Z") },
      ),
    ).resolves.toMatchObject({ artifactSha256: ARTIFACT_SHA });
    await expect(
      verifyCandidateAuthorization(
        { kind: "update", expected: checkedIdentity(signed.bytes) },
        artifact,
        signed.bytes,
        null,
        { trustRoot, now: new Date("2030-01-15T00:00:00.000Z") },
      ),
    ).rejects.toMatchObject({ code: "maintenance-required" });
  });

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
    expect(knownGood).toBeLessThan(previous);
    expect(previous).toBeLessThan(healthy);
  });

  it("creates a fresh PM2 process definition and rejects a restarted first process", () => {
    const helper = read("installer/ota-activate.mjs");

    expect(helper).toContain('await pm2(["delete", "worker"]);');
    expect(helper).toContain("first.restartCount !== 0");
  });

  it("projects the candidate onto new inodes before trusting root ownership", async () => {
    const releasesRoot = await mkdtemp(resolve(tmpdir(), "ota-releases-"));
    roots.push(releasesRoot);
    const candidate = `1.4.2-${ARTIFACT_SHA}`;
    const candidateRoot = resolve(releasesRoot, candidate);
    await mkdir(candidateRoot, { mode: 0o755 });
    const filePath = resolve(candidateRoot, "worker.js");
    writeFileSync(filePath, "trusted bytes", { mode: 0o644 });
    const retained = await open(filePath, "r+");
    const uid = process.getuid();
    const gid = process.getgid();
    const expected = await digestTree(candidateRoot, uid);

    try {
      await adoptCandidateTree(candidate, expected, {
        releasesRoot,
        ownerUid: uid,
        ownerGid: gid,
      });
      await retained.write(Buffer.from("attacker"), 0, 8, 0);
      await retained.sync();

      expect(await readFile(resolve(candidateRoot, "worker.js"), "utf8")).toBe(
        "trusted bytes",
      );
      expect(await digestTree(candidateRoot, uid)).toBe(expected);
    } finally {
      await retained.close();
    }
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
