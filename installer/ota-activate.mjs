import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const INSTALL_ROOT = "/opt/home-worker";
const RELEASES_ROOT = "/opt/home-worker/releases";
const JOURNAL_ROOT = "/opt/home-worker/shared/update";
const PROJECTION_ROOT = "/run/home-worker/activate";
const READY_PATH = "/run/home-worker/ready.json";
const OPERATION_ID = /^[A-Za-z0-9_-]{22}$/;
const RELEASE_NAME = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MARKERS = new Set([
  "artifact-state.json",
  "artifact-envelope.json",
  "known-good.json",
]);
const HOMEWORKER_ENV = {
  HOME: "/home/homeworker",
  PM2_HOME: "/home/homeworker/.pm2",
  PATH: "/usr/bin:/bin",
  NODE_ENV: "production",
  LANG: "C",
  LC_ALL: "C",
};

export class ActivationError extends Error {
  constructor(code) {
    super(code);
    this.name = "ActivationError";
    Object.defineProperty(this, "code", { value: code, enumerable: true });
  }
}

function fail(code = "maintenance-required") {
  throw new ActivationError(code);
}

function canonicalOperationId(value) {
  if (!OPERATION_ID.test(value)) fail();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== value) fail();
  return value;
}

async function readBytes(path, maximum = MAX_JSON_BYTES) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximum) fail();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      fail();
    }
    return bytes;
  } catch (error) {
    if (error instanceof ActivationError) throw error;
    fail();
  } finally {
    await handle.close();
  }
}

async function readJson(path, maximum = MAX_JSON_BYTES) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBytes(path, maximum),
      ),
    );
  } catch (error) {
    if (error instanceof ActivationError) throw error;
    fail();
  }
}

function releaseOrNull(value) {
  return (
    value === null || (typeof value === "string" && RELEASE_NAME.test(value))
  );
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function journalPayload(value) {
  return {
    schemaVersion: value.schemaVersion,
    generation: value.generation,
    operationId: value.operationId,
    kind: value.kind,
    phase: value.phase,
    expected: value.expected,
    acceptedAt: value.acceptedAt,
    requestSha256: value.requestSha256,
    receiptGeneration: value.receiptGeneration,
    priorCurrent: value.priorCurrent,
    priorPrevious: value.priorPrevious,
    candidate: value.candidate,
    preparedTreeSha256: value.preparedTreeSha256,
    diagnostics: value.diagnostics,
    updatedAt: value.updatedAt,
  };
}

function validJournal(value, operationId, phase = "prepared") {
  const payload = journalPayload(value);
  return (
    exactKeys(value, [
      "schemaVersion",
      "generation",
      "operationId",
      "kind",
      "phase",
      "expected",
      "acceptedAt",
      "requestSha256",
      "receiptGeneration",
      "priorCurrent",
      "priorPrevious",
      "candidate",
      "preparedTreeSha256",
      "diagnostics",
      "updatedAt",
      "checksum",
    ]) &&
    value.schemaVersion === 1 &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    value.operationId === operationId &&
    value.phase === phase &&
    (value.kind === "update" || value.kind === "rollback") &&
    ((value.kind === "update" && value.expected !== null) ||
      (value.kind === "rollback" && value.expected === null)) &&
    RELEASE_NAME.test(value.candidate) &&
    releaseOrNull(value.priorCurrent) &&
    releaseOrNull(value.priorPrevious) &&
    SHA256.test(value.preparedTreeSha256) &&
    SHA256.test(value.requestSha256) &&
    SHA256.test(value.checksum) &&
    createHash("sha256").update(JSON.stringify(payload)).digest("hex") ===
      value.checksum
  );
}

async function loadPreparedJournal(operationId) {
  const slots = [];
  for (const name of ["operation-a.json", "operation-b.json"]) {
    try {
      const path = join(JOURNAL_ROOT, name);
      const value = await readJson(path);
      if (validJournal(value, operationId)) {
        const info = await lstat(path);
        slots.push({ name, value, uid: info.uid, gid: info.gid });
      }
    } catch {}
  }
  if (slots.length === 0) fail();
  slots.sort(
    (left, right) =>
      left.value.generation - right.value.generation ||
      left.name.localeCompare(right.name),
  );
  if (
    slots.length === 2 &&
    slots[0].value.generation === slots[1].value.generation &&
    slots[0].value.checksum !== slots[1].value.checksum
  ) {
    fail();
  }
  return slots.at(-1);
}

async function transitionJournal(selected, phase, update = {}) {
  const previous = selected.value;
  const allowed = {
    prepared: ["activating"],
    activating: ["activated", "rolled_back", "rollback_failed"],
    activated: ["healthy", "rolled_back", "rollback_failed"],
    healthy: [],
  };
  if (!allowed[previous.phase]?.includes(phase)) fail();
  const payload = {
    ...journalPayload(previous),
    generation: previous.generation + 1,
    phase,
    preparedTreeSha256:
      update.preparedTreeSha256 ?? previous.preparedTreeSha256,
    diagnostics: update.diagnostics ?? previous.diagnostics,
    updatedAt: update.updatedAt ?? previous.updatedAt,
  };
  const next = {
    ...payload,
    checksum: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
  const targetName =
    selected.name === "operation-a.json"
      ? "operation-b.json"
      : "operation-a.json";
  const target = join(JOURNAL_ROOT, targetName);
  const temporary = join(JOURNAL_ROOT, `.${targetName}.${process.pid}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chown(selected.uid, selected.gid);
    await handle.writeFile(Buffer.from(JSON.stringify(next), "utf8"));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    renamed = true;
    const directory = await open(
      JOURNAL_ROOT,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return {
      name: targetName,
      value: next,
      uid: selected.uid,
      gid: selected.gid,
    };
  } finally {
    await handle?.close();
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

async function assertRootProjection(operationId, journal) {
  const path = join(PROJECTION_ROOT, `${operationId}.json`);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== 0 ||
    (info.mode & 0o022) !== 0
  )
    fail();
  const projection = await readJson(path, 64 * 1024);
  if (
    !exactKeys(projection, [
      "schemaVersion",
      "operationId",
      "generation",
      "checksum",
      "candidate",
      "preparedTreeSha256",
    ]) ||
    projection.schemaVersion !== 1 ||
    projection.operationId !== operationId ||
    projection.generation !== journal.generation ||
    projection.checksum !== journal.checksum ||
    projection.candidate !== journal.candidate ||
    projection.preparedTreeSha256 !== journal.preparedTreeSha256
  ) {
    fail();
  }
}

async function readPointer(name) {
  const path = join(INSTALL_ROOT, name);
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink() || info.uid !== 0) fail();
    const target = await readlink(path);
    const prefix = "releases/";
    const release = target.startsWith(prefix)
      ? target.slice(prefix.length)
      : "";
    if (!RELEASE_NAME.test(release) || target !== `${prefix}${release}`) fail();
    return release;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRecordedLinks(journal) {
  const install = await lstat(INSTALL_ROOT);
  const releases = await lstat(RELEASES_ROOT);
  if (
    !install.isDirectory() ||
    install.isSymbolicLink() ||
    install.uid !== 0 ||
    (install.mode & 0o022) !== 0 ||
    !releases.isDirectory() ||
    releases.isSymbolicLink() ||
    releases.uid !== 0 ||
    (releases.mode & 0o022) !== 0 ||
    (await readPointer("current")) !== journal.priorCurrent ||
    (await readPointer("previous")) !== journal.priorPrevious
  ) {
    fail();
  }
}

async function adoptCandidate(journal) {
  const path = resolve(RELEASES_ROOT, journal.candidate);
  if (dirname(path) !== RELEASES_ROOT || basename(path) !== journal.candidate)
    fail();
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
  await run("/bin/chown", ["-R", "--no-dereference", "0:0", "--", path]);
  await run("/bin/sync", ["-f", path]);
}

function prefix(value) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

async function digestTree(root) {
  const records = [];
  async function walk(directory, relativeDirectory) {
    const names = await readdir(directory);
    names.sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    for (const name of names) {
      if (!name || name === "." || name === ".." || name.includes("/"))
        fail("prepared-tree");
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      const path = join(directory, name);
      const entry = await lstat(path);
      if (entry.uid !== 0 || (entry.mode & 0o022) !== 0) fail();
      if (
        MARKERS.has(relativePath) &&
        entry.isFile() &&
        !entry.isSymbolicLink()
      )
        continue;
      let entryType;
      let contentIdentity;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        entryType = "directory";
        contentIdentity = "";
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        entryType = "file";
        contentIdentity = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      } else if (entry.isSymbolicLink()) {
        entryType = "symlink";
        contentIdentity = await readlink(path);
      } else fail("prepared-tree");
      records.push({
        relativePath,
        entryType,
        normalizedMode: (entry.mode & 0o7777).toString(8).padStart(4, "0"),
        contentIdentity,
      });
      if (entryType === "directory") await walk(path, relativePath);
    }
  }
  await walk(root, "");
  const hash = createHash("sha256");
  for (const record of records) {
    hash.update(prefix(record.relativePath));
    hash.update(prefix(record.entryType));
    hash.update(prefix(record.normalizedMode));
    hash.update(prefix(record.contentIdentity));
  }
  return hash.digest("hex");
}

async function revalidateCandidate(journal) {
  const path = resolve(RELEASES_ROOT, journal.candidate);
  if (dirname(path) !== RELEASES_ROOT || basename(path) !== journal.candidate)
    fail();
  const entry = await lstat(path);
  if (
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.uid !== 0 ||
    (entry.mode & 0o022) !== 0
  )
    fail();
  const marker = await readJson(join(path, "artifact-state.json"), 128 * 1024);
  const envelope = await readBytes(
    join(path, "artifact-envelope.json"),
    MAX_JSON_BYTES,
  );
  const envelopeSha = createHash("sha256").update(envelope).digest("hex");
  const expected = journal.expected;
  if (
    !exactKeys(marker, [
      "schemaVersion",
      "artifact",
      "metadata",
      "envelopeSha256",
      "preparedTreeSha256",
      "writtenAt",
    ]) ||
    marker.schemaVersion !== 1 ||
    !SHA256.test(marker.artifact?.sha256) ||
    !SHA256.test(marker.metadata?.payloadSha256) ||
    marker.envelopeSha256 !== envelopeSha ||
    marker.preparedTreeSha256 !== journal.preparedTreeSha256 ||
    !journal.candidate.endsWith(`-${marker.artifact.sha256}`) ||
    (journal.kind === "update" &&
      (expected === null ||
        expected.artifact.sha256 !== marker.artifact.sha256 ||
        expected.metadata.payloadSha256 !== marker.metadata.payloadSha256)) ||
    (await digestTree(path)) !== journal.preparedTreeSha256
  ) {
    fail();
  }
  if (journal.kind === "rollback") {
    const knownGood = await readJson(join(path, "known-good.json"), 64 * 1024);
    if (
      !exactKeys(knownGood, [
        "schemaVersion",
        "operationId",
        "artifactSha256",
        "metadataSha256",
        "preparedTreeSha256",
        "activatedAt",
      ]) ||
      knownGood.schemaVersion !== 1 ||
      !OPERATION_ID.test(knownGood.operationId) ||
      knownGood.artifactSha256 !== marker.artifact.sha256 ||
      knownGood.metadataSha256 !== marker.metadata.payloadSha256 ||
      knownGood.preparedTreeSha256 !== journal.preparedTreeSha256
    ) {
      fail();
    }
  }
  return {
    path,
    artifactSha256: marker.artifact.sha256,
    metadataSha256: marker.metadata.payloadSha256,
  };
}

async function run(command, args, options = {}) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "inherit",
      env: options.env,
      cwd: options.cwd,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 && signal === null
        ? accept()
        : reject(new Error("command failed")),
    );
  });
}

async function capture(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null || size > MAX_JSON_BYTES) {
        reject(new Error("command failed"));
      } else accept(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function atomicLink(name, target) {
  if ((name !== "current" && name !== "previous") || !RELEASE_NAME.test(target))
    fail();
  const destination = join(INSTALL_ROOT, name);
  const temporary = join(INSTALL_ROOT, `.${name}.${process.pid}.tmp`);
  await unlink(temporary).catch(() => undefined);
  await symlink(`releases/${target}`, temporary);
  await rename(temporary, destination);
  const directory = await open(
    INSTALL_ROOT,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function removeLink(name) {
  await unlink(join(INSTALL_ROOT, name)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function restoreLinks(journal) {
  if (journal.priorCurrent === null) await removeLink("current");
  else await atomicLink("current", journal.priorCurrent);
  if (journal.priorPrevious === null) await removeLink("previous");
  else await atomicLink("previous", journal.priorPrevious);
}

async function pm2(arguments_, environment = {}) {
  return run("/usr/bin/sudo", [
    "-u",
    "homeworker",
    "--",
    "/usr/bin/env",
    "-i",
    ...Object.entries({ ...HOMEWORKER_ENV, ...environment }).map(
      ([key, value]) => `${key}=${value}`,
    ),
    "/usr/bin/pm2",
    ...arguments_,
  ]);
}

async function inspectWorker() {
  const source = await capture("/usr/bin/sudo", [
    "-u",
    "homeworker",
    "--",
    "/usr/bin/env",
    "-i",
    ...Object.entries(HOMEWORKER_ENV).map(([key, value]) => `${key}=${value}`),
    "/usr/bin/pm2",
    "jlist",
  ]);
  const list = JSON.parse(source);
  const matches = list.filter((entry) => entry.name === "worker");
  if (matches.length !== 1) fail("pm2");
  const entry = matches[0];
  const snapshot = {
    pid: entry.pid,
    restartCount: entry.pm2_env?.restart_time,
    status: entry.pm2_env?.status,
    startedAt: entry.pm2_env?.pm_uptime,
  };
  if (
    !Number.isSafeInteger(snapshot.pid) ||
    snapshot.pid <= 0 ||
    !Number.isSafeInteger(snapshot.restartCount) ||
    snapshot.restartCount < 0 ||
    snapshot.status !== "online" ||
    !Number.isSafeInteger(snapshot.startedAt) ||
    snapshot.startedAt <= 0
  ) {
    fail("pm2");
  }
  return snapshot;
}

async function waitForHealth(operationId, candidate, first) {
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    const observed = await inspectWorker();
    if (
      observed.pid !== first.pid ||
      observed.restartCount !== first.restartCount
    ) {
      fail("restart-loop");
    }
    let marker = null;
    try {
      marker = await readJson(READY_PATH, 64 * 1024);
    } catch {}
    if (
      exactKeys(marker, [
        "schemaVersion",
        "operationId",
        "pid",
        "artifactSha256",
        "metadataSha256",
        "writtenAt",
      ]) &&
      marker.schemaVersion === 1 &&
      marker.operationId === operationId &&
      marker.pid === first.pid &&
      marker.artifactSha256 === candidate.artifactSha256 &&
      marker.metadataSha256 === candidate.metadataSha256 &&
      Date.now() - first.startedAt >= 60_000
    ) {
      return;
    }
    await new Promise((accept) => setTimeout(accept, 1_000));
  }
  fail("readiness");
}

async function writeKnownGood(candidate, operationId, preparedTreeSha256) {
  const path = join(candidate.path, "known-good.json");
  const temporary = join(candidate.path, `.known-good.json.${process.pid}.tmp`);
  const marker = {
    schemaVersion: 1,
    operationId,
    artifactSha256: candidate.artifactSha256,
    metadataSha256: candidate.metadataSha256,
    preparedTreeSha256,
    activatedAt: new Date().toISOString(),
  };
  let handle;
  let renamed = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
    await handle.writeFile(Buffer.from(JSON.stringify(marker), "utf8"));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    renamed = true;
    const directory = await open(
      candidate.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return marker;
  } finally {
    await handle?.close();
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

export async function activateOperation(operationIdInput) {
  const operationId = canonicalOperationId(operationIdInput);
  let selected = await loadPreparedJournal(operationId);
  await assertRootProjection(operationId, selected.value);
  await assertRecordedLinks(selected.value);
  await adoptCandidate(selected.value);
  const candidate = await revalidateCandidate(selected.value);

  let switched = false;
  try {
    await unlink(READY_PATH).catch(() => undefined);
    await pm2(["stop", "worker"]);
    await run(
      "/usr/bin/sudo",
      [
        "-u",
        "homeworker",
        "--",
        "/usr/bin/env",
        "-i",
        ...Object.entries(HOMEWORKER_ENV).map(
          ([key, value]) => `${key}=${value}`,
        ),
        "/usr/bin/node",
        join(candidate.path, "dist/system/infrastructure/migrate.entry.js"),
      ],
      { cwd: candidate.path },
    );
    selected = await transitionJournal(selected, "activating", {
      updatedAt: new Date().toISOString(),
    });
    switched = true;
    await atomicLink("current", selected.value.candidate);
    selected = await transitionJournal(selected, "activated", {
      updatedAt: new Date().toISOString(),
    });
    await pm2(
      [
        "start",
        "/usr/lib/home-worker/ecosystem.config.cjs",
        "--only",
        "worker",
        "--update-env",
      ],
      {
        HOME_WORKER_OTA_OPERATION_ID: operationId,
        HOME_WORKER_OTA_ARTIFACT_SHA256: candidate.artifactSha256,
        HOME_WORKER_OTA_METADATA_SHA256: candidate.metadataSha256,
      },
    );
    const first = await inspectWorker();
    await waitForHealth(operationId, candidate, first);
    const knownGood = await writeKnownGood(
      candidate,
      operationId,
      selected.value.preparedTreeSha256,
    );
    selected = await transitionJournal(selected, "healthy", {
      updatedAt: knownGood.activatedAt,
    });
    if (selected.value.priorCurrent === null) await removeLink("previous");
    else await atomicLink("previous", selected.value.priorCurrent);
  } catch (error) {
    try {
      if (switched) await restoreLinks(selected.value);
      await pm2([
        "start",
        "/usr/lib/home-worker/ecosystem.config.cjs",
        "--only",
        "worker",
        "--update-env",
      ]);
    } catch {
      if (
        selected.value.phase === "activating" ||
        selected.value.phase === "activated"
      ) {
        await transitionJournal(selected, "rollback_failed", {
          diagnostics: {
            code: "rollback",
            notes: [],
          },
          updatedAt: new Date().toISOString(),
        }).catch(() => undefined);
      }
      fail("rollback");
    }
    if (
      switched &&
      (selected.value.phase === "activating" ||
        selected.value.phase === "activated")
    ) {
      selected = await transitionJournal(selected, "rolled_back", {
        diagnostics: {
          code: error instanceof ActivationError ? error.code : "activation",
          notes: [],
        },
        updatedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  if (process.argv.length !== 3) process.exit(64);
  activateOperation(process.argv[2]).catch(() => process.exit(75));
}
