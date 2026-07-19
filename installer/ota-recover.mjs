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

function hasCommittedCandidate(journal, pointers, knownGood) {
  return (
    journal.candidate !== null &&
    journal.preparedTreeSha256 !== null &&
    pointers.current === journal.candidate &&
    pointers.previous === journal.priorCurrent &&
    knownGood !== null &&
    knownGood.operationId === journal.operationId &&
    knownGood.preparedTreeSha256 === journal.preparedTreeSha256 &&
    /^[0-9a-f]{64}$/.test(knownGood.artifactSha256) &&
    /^[0-9a-f]{64}$/.test(knownGood.metadataSha256) &&
    journal.candidate.endsWith(`-${knownGood.artifactSha256}`) &&
    (journal.kind === "rollback" ||
      (journal.expected !== null &&
        journal.expected.artifact.sha256 === knownGood.artifactSha256 &&
        journal.expected.metadata.payloadSha256 === knownGood.metadataSha256))
  );
}

function hasRestorablePointers(journal, pointers) {
  return (
    (journal.phase === "activating" &&
      (pointers.current === journal.priorCurrent ||
        pointers.current === journal.candidate) &&
      pointers.previous === journal.priorPrevious) ||
    (journal.phase === "activated" &&
      pointers.current === journal.candidate &&
      (pointers.previous === journal.priorPrevious ||
        pointers.previous === journal.priorCurrent))
  );
}

async function stopForMaintenance(dependencies) {
  await dependencies.reports.writeDurably(
    maintenanceReport(dependencies.now()),
  );
  await dependencies.root.stop();
}

async function inspectKnownGood(dependencies, release) {
  try {
    const value = await dependencies.local.knownGood(release);
    return value === null
      ? { kind: "missing", value: null }
      : { kind: "found", value };
  } catch {
    return { kind: "invalid", value: null };
  }
}

async function readKnownGood(dependencies, release) {
  return (await inspectKnownGood(dependencies, release)).value;
}

export async function recoverInterruptedActivation(dependencies) {
  let journal;
  try {
    journal = await dependencies.journal.load();
  } catch {
    await stopForMaintenance(dependencies);
    return;
  }
  if (journal === null) return;

  let pointers;
  try {
    pointers = await dependencies.local.pointers();
  } catch {
    await stopForMaintenance(dependencies);
    return;
  }
  const candidateInspection = await inspectKnownGood(
    dependencies,
    journal.candidate,
  );
  if (candidateInspection.kind === "invalid") {
    await stopForMaintenance(dependencies);
    return;
  }
  const candidateKnownGood = candidateInspection.value;
  const committedCandidate = hasCommittedCandidate(
    journal,
    pointers,
    candidateKnownGood,
  );

  switch (journal.phase) {
    case "activated":
      if (candidateKnownGood !== null) {
        if (committedCandidate) {
          await dependencies.root.invoke(
            journal.operationId,
            "finalize-healthy",
          );
          await dependencies.reports.writeDurably(
            operationReport(
              journal,
              candidateKnownGood,
              journal.kind === "update" ? "updated" : "rolled-back",
              dependencies.now(),
            ),
          );
          return;
        }
        await stopForMaintenance(dependencies);
        return;
      }
    // An activated candidate without complete commit proof uses the same
    // fail-safe restoration path as a partially completed activating phase.
    case "activating": {
      if (!hasRestorablePointers(journal, pointers)) {
        await stopForMaintenance(dependencies);
        return;
      }
      const priorKnownGood = await readKnownGood(
        dependencies,
        journal.priorCurrent,
      );
      if (priorKnownGood === null) {
        await stopForMaintenance(dependencies);
        return;
      }
      await dependencies.reports.writeDurably(
        operationReport(journal, priorKnownGood, "failed", dependencies.now()),
      );
      await dependencies.root.invoke(journal.operationId, "restore-prior");
      return;
    }

    case "healthy":
      if (!committedCandidate) {
        await stopForMaintenance(dependencies);
        return;
      }
      await dependencies.reports.writeDurably(
        operationReport(
          journal,
          candidateKnownGood,
          journal.kind === "update" ? "updated" : "rolled-back",
          dependencies.now(),
        ),
      );
      return;

    case "rolled_back": {
      const priorKnownGood = await readKnownGood(
        dependencies,
        journal.priorCurrent,
      );
      if (
        pointers.current !== journal.priorCurrent ||
        pointers.previous !== journal.priorPrevious ||
        priorKnownGood === null
      ) {
        await stopForMaintenance(dependencies);
        return;
      }
      await dependencies.reports.writeDurably(
        operationReport(journal, priorKnownGood, "failed", dependencies.now()),
      );
      await dependencies.root.invoke(journal.operationId, "restore-prior");
      return;
    }

    case "preparing":
    case "prepared":
    case "failed_pre_activation":
    case "rollback_failed":
    case "cleanup_pending":
    default:
      await stopForMaintenance(dependencies);
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
  if (candidate === null) return null;
  if (!RELEASE.test(candidate)) throw new Error("known-good release");
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
      throw new Error("known-good ownership");
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
        throw new Error("known-good contract");
      return value;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
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
