import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const OPERATION_ID = /^[A-Za-z0-9_-]{22}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_NAME = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[0-9a-f]{64}$/;
const RECEIPT_KEYS = [
  "schemaVersion",
  "operationId",
  "candidate",
  "artifactSha256",
  "metadataSha256",
  "inventorySha256",
];
const FIXED_INPUTS = [
  "package.json",
  "yarn.lock",
  ".yarnrc.yml",
  ".yarn/releases/yarn-4.13.0.cjs",
  "artifact-state.json",
];
const YARN_POLICY = new Map([
  ["nodeLinker", "node-modules"],
  ["enableGlobalCache", "false"],
  ["enableNetwork", "false"],
  ["enableImmutableInstalls", "true"],
  ["enableImmutableCache", "true"],
  ["cacheFolder", ".yarn/cache"],
  ["yarnPath", ".yarn/releases/yarn-4.13.0.cjs"],
]);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_CACHE_ENTRIES = 200_000;
const MAX_CACHE_EXPANDED_BYTES = 1024 * 1024 * 1024;
const MAX_CACHE_PATH_BYTES = 240;

export class PreparationError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreparationError";
    Object.defineProperty(this, "code", { value: code, enumerable: true });
  }
}

function fail(code = "dependency-sandbox") {
  throw new PreparationError(code);
}

function isCanonicalOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 16 && bytes.toString("base64url") === value;
}

function sortedKeys(value) {
  return Object.keys(value).sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

function strictReceipt(source, operationId) {
  if (source.startsWith("\uFEFF")) fail();
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail();
  if (
    JSON.stringify(sortedKeys(value)) !==
    JSON.stringify([...RECEIPT_KEYS].sort())
  )
    fail();
  for (const key of RECEIPT_KEYS) {
    const matches = source.match(new RegExp(`"${key}"\\s*:`, "g"));
    if (matches?.length !== 1) fail();
  }
  if (
    value.schemaVersion !== 1 ||
    value.operationId !== operationId ||
    !isCanonicalOperationId(value.operationId) ||
    typeof value.candidate !== "string" ||
    !RELEASE_NAME.test(value.candidate) ||
    !SHA256.test(value.artifactSha256) ||
    !SHA256.test(value.metadataSha256) ||
    !SHA256.test(value.inventorySha256) ||
    !value.candidate.endsWith(`-${value.artifactSha256}`)
  ) {
    fail();
  }
  return value;
}

async function readBounded(path, maxBytes = MAX_JSON_BYTES) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) fail();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      fail();
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail();
    }
  } finally {
    await handle.close();
  }
}

async function assertRootOwned(path, kind) {
  const info = await lstat(path);
  if (info.uid !== 0 || (info.mode & 0o022) !== 0) fail();
  if (kind === "file" && (!info.isFile() || info.isSymbolicLink())) fail();
  if (kind === "directory" && (!info.isDirectory() || info.isSymbolicLink()))
    fail();
  if (kind === "symlink" && !info.isSymbolicLink()) fail();
}

function canonicalCachePath(name, allowDirectory) {
  const path = allowDirectory && name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    Buffer.byteLength(path, "utf8") > MAX_CACHE_PATH_BYTES ||
    path.startsWith("/") ||
    path
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..") ||
    [...path].some((character) => {
      const code = character.codePointAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    fail("archive-policy");
  }
  return path;
}

async function readAt(handle, length, position) {
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 64 * 1024 * 1024
  ) {
    fail("archive-policy");
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) fail("archive-policy");
  return buffer;
}

async function zipTotals(handle, size) {
  const tailSize = Math.min(size, 65_557);
  const tailOffset = size - tailSize;
  const tail = await readAt(handle, tailSize, tailOffset);
  let eocd = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > tail.length) fail("archive-policy");
  const disk = tail.readUInt16LE(eocd + 4);
  const centralDisk = tail.readUInt16LE(eocd + 6);
  const diskEntries = tail.readUInt16LE(eocd + 8);
  const entryCount = tail.readUInt16LE(eocd + 10);
  const centralSize = tail.readUInt32LE(eocd + 12);
  const centralOffset = tail.readUInt32LE(eocd + 16);
  const commentLength = tail.readUInt16LE(eocd + 20);
  const eocdAbsolute = tailOffset + eocd;
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    eocdAbsolute + 22 + commentLength !== size ||
    centralOffset + centralSize !== eocdAbsolute ||
    entryCount > MAX_CACHE_ENTRIES
  ) {
    fail("archive-policy");
  }

  const central = await readAt(handle, centralSize, centralOffset);
  const names = new Set();
  let cursor = 0;
  let expandedBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > central.length ||
      central.readUInt32LE(cursor) !== 0x02014b50
    ) {
      fail("archive-policy");
    }
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    const expanded = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentBytes = central.readUInt16LE(cursor + 32);
    const startDisk = central.readUInt16LE(cursor + 34);
    const recordLength = 46 + nameLength + extraLength + commentBytes;
    if (
      (flags & 1) !== 0 ||
      (method !== 0 && method !== 8) ||
      expanded === 0xffffffff ||
      startDisk !== 0 ||
      cursor + recordLength > central.length
    ) {
      fail("archive-policy");
    }
    let name;
    try {
      name = decoder.decode(
        central.subarray(cursor + 46, cursor + 46 + nameLength),
      );
    } catch {
      fail("archive-policy");
    }
    const canonical = canonicalCachePath(name, true);
    if (names.has(canonical)) fail("archive-policy");
    names.add(canonical);
    expandedBytes += expanded;
    if (
      !Number.isSafeInteger(expandedBytes) ||
      expandedBytes > MAX_CACHE_EXPANDED_BYTES
    ) {
      fail("archive-policy");
    }
    cursor += recordLength;
  }
  if (cursor !== central.length) fail("archive-policy");
  return { entryCount, expandedBytes };
}

async function hashOpenFile(handle) {
  const hash = createHash("sha256");
  const stream = createReadStream("", {
    fd: handle.fd,
    autoClose: false,
    start: 0,
  });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectCacheArchive(path, name) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size))
      fail("archive-policy");
    const sha256 = await hashOpenFile(handle);
    const totals = await zipTotals(handle, before.size);
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      fail("archive-policy");
    }
    return { record: { path: name, size: before.size, sha256 }, ...totals };
  } finally {
    await handle.close();
  }
}

export async function inspectCacheInventory(cacheRoot) {
  try {
    const rootInfo = await lstat(cacheRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      fail("archive-policy");
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
    );
    const archives = [];
    let entryCount = 0;
    let expandedBytes = 0;
    for (const entry of entries) {
      const name = canonicalCachePath(entry.name, false);
      if (!entry.isFile() || entry.isSymbolicLink() || !name.endsWith(".zip")) {
        fail("archive-policy");
      }
      const inspected = await inspectCacheArchive(join(cacheRoot, name), name);
      archives.push(inspected.record);
      entryCount += inspected.entryCount;
      expandedBytes += inspected.expandedBytes;
      if (
        entryCount > MAX_CACHE_ENTRIES ||
        expandedBytes > MAX_CACHE_EXPANDED_BYTES
      ) {
        fail("archive-policy");
      }
    }
    const inventory = { archives, entryCount, expandedBytes };
    return {
      ...inventory,
      sha256: createHash("sha256")
        .update(JSON.stringify(inventory))
        .digest("hex"),
    };
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail("archive-policy");
  }
}

async function stableFileSha256(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail();
    const sha256 = await hashOpenFile(handle);
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      fail();
    }
    return sha256;
  } finally {
    await handle.close();
  }
}

async function fixedInputSnapshot(candidate) {
  const hashes = {};
  for (const path of FIXED_INPUTS)
    hashes[path] = await stableFileSha256(join(candidate, path));
  return hashes;
}

function assertYarnPolicy(source) {
  const policy = new Map();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) fail();
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (policy.has(key)) fail();
    policy.set(key, value);
  }
  if (policy.size !== YARN_POLICY.size) fail();
  for (const [key, value] of YARN_POLICY) if (policy.get(key) !== value) fail();
}

function assertCandidateMarker(source, receipt) {
  let marker;
  try {
    marker = JSON.parse(source);
  } catch {
    fail();
  }
  if (
    marker?.schemaVersion !== 1 ||
    marker?.artifact?.sha256 !== receipt.artifactSha256 ||
    marker?.metadata?.payloadSha256 !== receipt.metadataSha256
  ) {
    fail();
  }
}

function assertPackageManager(source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    fail();
  }
  if (manifest?.packageManager !== "yarn@4.13.0") fail();
}

function fixedEnvironment(operationRoot) {
  const temp = join(operationRoot, "tmp");
  const home = join(temp, "home");
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    NODE_ENV: "production",
    NODE_OPTIONS: "--max-old-space-size=512",
    npm_config_jobs: "1",
    npm_config_cache: join(temp, "npm-cache"),
    JOBS: "1",
    YARN_ENABLE_NETWORK: "false",
    YARN_ENABLE_GLOBAL_CACHE: "false",
    YARN_ENABLE_IMMUTABLE_INSTALLS: "true",
    YARN_ENABLE_IMMUTABLE_CACHE: "true",
    YARN_CACHE_FOLDER: ".yarn/cache",
    YARN_IGNORE_PATH: "true",
  });
}

async function defaultRunner({ command, args, cwd, env }) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolveRun();
      else rejectRun(new Error("dependency install failed"));
    });
  });
}

async function runPreparation(
  operationId,
  runner = defaultRunner,
  options = {},
) {
  if (!isCanonicalOperationId(operationId)) fail();
  const runtimeRoot = resolve(
    options.runtimeRoot ?? "/run/home-worker/prepare",
  );
  const releasesRoot = resolve(
    options.releasesRoot ?? "/opt/home-worker/releases",
  );
  const enforceRootOwnership = options.enforceRootOwnership ?? true;
  const receiptPath = join(runtimeRoot, `${operationId}.json`);
  const operationRoot = join(runtimeRoot, operationId);
  const candidateProjection = join(operationRoot, "candidate");
  const temp = join(operationRoot, "tmp");

  if (enforceRootOwnership) {
    await assertRootOwned(runtimeRoot, "directory");
    await assertRootOwned(operationRoot, "directory");
    await assertRootOwned(receiptPath, "file");
    await assertRootOwned(candidateProjection, "symlink");
  }
  const operationReal = await realpath(operationRoot);
  const tempInfo = await lstat(temp);
  if (
    !tempInfo.isDirectory() ||
    tempInfo.isSymbolicLink() ||
    (await realpath(temp)) !== join(operationReal, "tmp")
  ) {
    fail();
  }
  await mkdir(join(temp, "home"), { mode: 0o700 });

  const receipt = strictReceipt(await readBounded(receiptPath), operationId);
  const releasesReal = await realpath(releasesRoot);
  const expectedCandidate = resolve(releasesReal, receipt.candidate);
  if (
    dirname(expectedCandidate) !== releasesReal ||
    basename(expectedCandidate) !== receipt.candidate
  )
    fail();
  const candidate = await realpath(candidateProjection);
  if (
    candidate !== expectedCandidate ||
    (await realpath(expectedCandidate)) !== expectedCandidate
  )
    fail();

  assertCandidateMarker(
    await readBounded(join(candidate, "artifact-state.json")),
    receipt,
  );
  assertPackageManager(await readBounded(join(candidate, "package.json")));
  assertYarnPolicy(await readBounded(join(candidate, ".yarnrc.yml")));

  const beforeInputs = await fixedInputSnapshot(candidate);
  const beforeInventory = await inspectCacheInventory(
    join(candidate, ".yarn", "cache"),
  );
  if (beforeInventory.sha256 !== receipt.inventorySha256)
    fail("cache-mutation");

  try {
    await runner({
      command: "/usr/bin/node",
      args: [
        ".yarn/releases/yarn-4.13.0.cjs",
        "workspaces",
        "focus",
        "-A",
        "--production",
      ],
      cwd: candidate,
      env: fixedEnvironment(operationRoot),
    });
  } catch {
    fail("dependency-install");
  }

  let afterInputs;
  let afterInventory;
  try {
    afterInputs = await fixedInputSnapshot(candidate);
    afterInventory = await inspectCacheInventory(
      join(candidate, ".yarn", "cache"),
    );
  } catch {
    fail("cache-mutation");
  }
  if (
    JSON.stringify(afterInputs) !== JSON.stringify(beforeInputs) ||
    afterInventory.sha256 !== beforeInventory.sha256 ||
    afterInventory.sha256 !== receipt.inventorySha256
  ) {
    fail("cache-mutation");
  }
}

export async function prepareDependencies(
  operationId,
  runner = defaultRunner,
  options = {},
) {
  try {
    await runPreparation(operationId, runner, options);
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail();
  }
}

async function main() {
  if (process.argv.length !== 3) fail();
  await prepareDependencies(process.argv[2]);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code =
      error instanceof PreparationError ? error.code : "dependency-sandbox";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
