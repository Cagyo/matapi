import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadOperationJournal, writeStartupReport } from "./ota-contracts.mjs";

const INSTALL_ROOT = "/opt/home-worker";
const RELEASES_ROOT = "/opt/home-worker/releases";
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9a-f]{64}$/;

function maintenanceReport(now) {
  return {
    schemaVersion: 1,
    operationId: null,
    kind: null,
    outcome: "maintenance-required",
    artifactSha256: null,
    metadataSha256: null,
    failure: { code: "maintenance-required" },
    writtenAt: now.toISOString(),
  };
}

function operationReport(journal, knownGood, outcome, now) {
  return {
    schemaVersion: 1,
    operationId: journal.operationId,
    kind: journal.kind,
    outcome,
    artifactSha256: knownGood.artifactSha256,
    metadataSha256: knownGood.metadataSha256,
    failure: outcome === "failed" ? { code: "activation" } : null,
    writtenAt: now.toISOString(),
  };
}

function canFinalize(journal, pointers, knownGood) {
  return (
    journal.phase === "activated" &&
    journal.candidate !== null &&
    journal.preparedTreeSha256 !== null &&
    pointers.current === journal.candidate &&
    pointers.previous === journal.priorCurrent &&
    knownGood !== null &&
    knownGood.operationId === journal.operationId &&
    knownGood.preparedTreeSha256 === journal.preparedTreeSha256 &&
    /^[0-9a-f]{64}$/.test(knownGood.artifactSha256) &&
    /^[0-9a-f]{64}$/.test(knownGood.metadataSha256)
  );
}

export async function recoverInterruptedActivation(dependencies) {
  let journal;
  try {
    journal = await dependencies.journal.load();
  } catch {
    await dependencies.reports.writeDurably(
      maintenanceReport(dependencies.now()),
    );
    await dependencies.root.stop();
    return;
  }
  if (journal === null) return;

  let pointers;
  try {
    pointers = await dependencies.local.pointers();
  } catch {
    await dependencies.reports.writeDurably(
      maintenanceReport(dependencies.now()),
    );
    await dependencies.root.stop();
    return;
  }
  let knownGood = null;
  try {
    knownGood = await dependencies.local.knownGood(journal.candidate);
  } catch {}

  if (canFinalize(journal, pointers, knownGood)) {
    await dependencies.root.invoke(journal.operationId, "finalize-healthy");
    await dependencies.reports.writeDurably(
      operationReport(
        journal,
        knownGood,
        journal.kind === "update" ? "updated" : "rolled-back",
        dependencies.now(),
      ),
    );
    return;
  }

  if (journal.phase === "activating" || journal.phase === "activated") {
    const priorKnownGood = await dependencies.local.knownGood(
      journal.priorCurrent,
    );
    if (priorKnownGood === null) {
      await dependencies.reports.writeDurably(
        maintenanceReport(dependencies.now()),
      );
      await dependencies.root.stop();
      return;
    }
    await dependencies.root.invoke(journal.operationId, "restore-prior");
    await dependencies.reports.writeDurably(
      operationReport(journal, priorKnownGood, "failed", dependencies.now()),
    );
    return;
  }

  if (journal.phase === "healthy") {
    if (knownGood === null) {
      await dependencies.reports.writeDurably(
        maintenanceReport(dependencies.now()),
      );
      await dependencies.root.stop();
      return;
    }
    await dependencies.reports.writeDurably(
      operationReport(
        journal,
        knownGood,
        journal.kind === "update" ? "updated" : "rolled-back",
        dependencies.now(),
      ),
    );
  }
}

async function pointer(name) {
  const path = join(INSTALL_ROOT, name);
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink() || info.uid !== 0) throw new Error("pointer");
    const target = await readlink(path);
    const prefix = "releases/";
    const release = target.startsWith(prefix)
      ? target.slice(prefix.length)
      : "";
    if (!RELEASE.test(release) || target !== `${prefix}${release}`)
      throw new Error("pointer");
    return release;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function knownGood(candidate) {
  if (candidate === null || !RELEASE.test(candidate)) return null;
  const path = join(RELEASES_ROOT, candidate, "known-good.json");
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0 ||
      info.size < 1 ||
      info.size > 64 * 1024
    )
      return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        await handle.readFile(),
      );
      const value = JSON.parse(text);
      if (
        text !== JSON.stringify(value) ||
        Object.keys(value).sort().join("\0") !==
          [
            "schemaVersion",
            "operationId",
            "artifactSha256",
            "metadataSha256",
            "preparedTreeSha256",
            "activatedAt",
          ]
            .sort()
            .join("\0") ||
        value.schemaVersion !== 1 ||
        !/^[A-Za-z0-9_-]{22}$/.test(value.operationId) ||
        !/^[0-9a-f]{64}$/.test(value.artifactSha256) ||
        !/^[0-9a-f]{64}$/.test(value.metadataSha256) ||
        !/^[0-9a-f]{64}$/.test(value.preparedTreeSha256) ||
        typeof value.activatedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          value.activatedAt,
        ) ||
        new Date(Date.parse(value.activatedAt)).toISOString() !==
          value.activatedAt
      )
        return null;
      return value;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function invokeRoot(operationId, action) {
  const flag =
    action === "finalize-healthy"
      ? "--recover-finalize"
      : action === "restore-prior"
        ? "--recover-restore"
        : null;
  if (flag === null) throw new Error("recovery action");
  await new Promise((accept, reject) => {
    const child = spawn(
      "/usr/bin/sudo",
      [
        "-n",
        "/usr/bin/node",
        "/usr/lib/home-worker/ota-activate.mjs",
        flag,
        operationId,
      ],
      { shell: false, stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 && signal === null
        ? accept()
        : reject(new Error("root recovery failed")),
    );
  });
}

export async function runRecoveryAtBoot() {
  return recoverInterruptedActivation({
    journal: { load: () => loadOperationJournal() },
    local: {
      pointers: async () => ({
        current: await pointer("current"),
        previous: await pointer("previous"),
      }),
      knownGood,
    },
    root: {
      invoke: invokeRoot,
      stop: async () => {
        throw new Error("maintenance-required");
      },
    },
    reports: { writeDurably: (report) => writeStartupReport(report) },
    now: () => new Date(),
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  if (process.argv.length !== 2) process.exit(64);
  runRecoveryAtBoot().catch(() => process.exit(75));
}
