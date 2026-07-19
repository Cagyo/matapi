import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OPERATION_ID = /^[A-Za-z0-9_-]{22}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASE_NAME =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[0-9a-f]{64}$/u;
const RECEIPT_KEYS = Object.freeze([
  "schemaVersion",
  "operationId",
  "candidate",
  "artifactSha256",
  "metadataSha256",
]);
const FETCH_SENTINEL_KEYS = Object.freeze([
  "schemaVersion",
  "operationId",
  "candidate",
  "artifactSha256",
  "metadataSha256",
  "receiptSha256",
  "archiveInputSha256",
  "yarnLockSha256",
  "yarnRuntimeSha256",
  "coordinatorChallenge",
  "lifecycleScripts",
]);
const BUILD_SENTINEL_KEYS = Object.freeze([
  "schemaVersion",
  "operationId",
  "candidate",
  "artifactSha256",
  "metadataSha256",
  "receiptSha256",
  "archiveInputSha256",
  "preparedTreeSha256",
  "preparedFiles",
  "preparedBytes",
  "coordinatorChallenge",
  "network",
]);
const CHALLENGE_KEYS = Object.freeze([
  "schemaVersion",
  "operationId",
  "challenge",
]);
const YARN_RUNTIME_PATH = ".yarn/releases/yarn-4.13.0.cjs";
const YARN_POLICY = new Map([
  ["nodeLinker", "node-modules"],
  ["enableGlobalCache", "false"],
  ["enableNetwork", "false"],
  ["enableImmutableInstalls", "true"],
  ["enableScripts", "false"],
  ["checksumBehavior", "throw"],
  ["npmRegistryServer", "https://registry.npmjs.org"],
  ["npmAlwaysAuth", "false"],
  ["yarnPath", YARN_RUNTIME_PATH],
]);
const MAX_JSON_BYTES = 64 * 1024;
const MAX_PREPARED_FILES = 200_000;
const MAX_PREPARED_BYTES = 1024 * 1024 * 1024;
const GENERATED_PATHS = new Set(["node_modules", ".yarn/install-state.gz"]);
const FORBIDDEN_ROOT_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepack",
  "postpack",
  "prepublish",
  "prepublishOnly",
]);

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isCanonicalOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 16 && bytes.toString("base64url") === value;
}

function sortedKeys(value) {
  return Object.keys(value).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(sortedKeys(value)) ===
      JSON.stringify(
        [...keys].sort((left, right) =>
          Buffer.compare(Buffer.from(left), Buffer.from(right)),
        ),
      )
  );
}

function parseStrictJson(source, keys) {
  if (source.startsWith("\uFEFF")) fail();
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail();
  }
  if (!exactKeys(value, keys)) fail();
  for (const key of keys) {
    if (source.match(new RegExp(`"${key}"\\s*:`, "gu"))?.length !== 1) fail();
  }
  return value;
}

function strictReceipt(source, operationId) {
  const value = parseStrictJson(source, RECEIPT_KEYS);
  if (
    value.schemaVersion !== 1 ||
    value.operationId !== operationId ||
    !isCanonicalOperationId(value.operationId) ||
    typeof value.candidate !== "string" ||
    !RELEASE_NAME.test(value.candidate) ||
    !SHA256.test(value.artifactSha256) ||
    !SHA256.test(value.metadataSha256) ||
    !value.candidate.endsWith(`-${value.artifactSha256}`)
  ) {
    fail();
  }
  return value;
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
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

async function readStableFile(path, maxBytes = Number.MAX_SAFE_INTEGER) {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(maxBytes)
  ) {
    fail();
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) fail();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(opened, finalPath))
      fail();
    return bytes;
  } finally {
    await handle.close();
  }
}

async function stableFileSha256(path) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) fail();
    const digest = await hashOpenFile(handle);
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(opened, finalPath))
      fail();
    return digest;
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

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
}

function assertYarnPolicy(source) {
  if (
    typeof source !== "string" ||
    source.startsWith("\uFEFF") ||
    /[\r\u0085\u2028\u2029]/u.test(source)
  ) {
    fail();
  }
  const policy = new Map();
  for (const rawLine of source.split("\n")) {
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

function locatorProtocol(locator) {
  return /^(?:@[^/]+\/[^@]+|[^@]+)@([^:]+):/u.exec(locator)?.[1] ?? null;
}

function allowedLocator(locator) {
  const protocol = locatorProtocol(locator);
  const packageName = "(?:@[^/]+/)?[A-Za-z0-9._-]+";
  const exactVersion =
    "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?";
  if (protocol === "npm") {
    return new RegExp(`^${packageName}@npm:${exactVersion}$`, "u").test(
      locator,
    );
  }
  if (protocol === "workspace") {
    const match = new RegExp(`^${packageName}@workspace:(.+)$`, "u").exec(
      locator,
    );
    return (
      match !== null &&
      (match[1] === "." ||
        (!match[1].startsWith("/") &&
          match[1]
            .split("/")
            .every(
              (segment) =>
                /^[A-Za-z0-9._-]+$/u.test(segment) &&
                segment !== "." &&
                segment !== "..",
            )))
    );
  }
  if (protocol !== "patch") return false;
  const match =
    /^((?:@[^/]+\/)?[A-Za-z0-9._-]+)@patch:((?:@[^/]+\/)?[A-Za-z0-9._-]+)@npm%3A([^#\s]+)#(?:optional!)?builtin<compat\/([A-Za-z0-9._-]+)>::version=([^&\s]+)&hash=([0-9a-f]+)$/u.exec(
      locator,
    );
  return (
    match !== null &&
    match[1] === match[2] &&
    match[4] === match[1].split("/").at(-1) &&
    match[3] === match[5] &&
    new RegExp(`^${exactVersion}$`, "u").test(match[3])
  );
}

export function validateLockLocators(source) {
  if (
    typeof source !== "string" ||
    source.startsWith("\uFEFF") ||
    /[\r\u0085\u2028\u2029]/u.test(source)
  ) {
    fail();
  }
  if (
    /[\t{}\[\]\\]/u.test(source) ||
    /^\s*(?:<<\s*:|[&*][A-Za-z0-9_-]+)/mu.test(source)
  ) {
    fail();
  }
  const recordFields = new Set([
    "version",
    "resolution",
    "dependencies",
    "peerDependencies",
    "dependenciesMeta",
    "peerDependenciesMeta",
    "bin",
    "checksum",
    "conditions",
    "languageName",
    "linkType",
  ]);
  const lines = source.split("\n");
  const packages = new Set();
  let metadataSeen = false;
  let current = null;
  const finishBlock = () => {
    if (current?.kind === "package" && current.resolutions !== 1) fail();
  };
  for (const rawLine of lines) {
    if (rawLine === "" || rawLine.startsWith("#")) continue;
    if (rawLine === "__metadata:") {
      finishBlock();
      if (metadataSeen || packages.size > 0) fail();
      metadataSeen = true;
      current = { kind: "metadata", fields: new Set() };
      continue;
    }
    if (rawLine.startsWith('"')) {
      finishBlock();
      if (!metadataSeen || !/^"[^"]+":$/u.test(rawLine)) fail();
      const encodedKey = rawLine.slice(0, -1);
      let key;
      try {
        key = JSON.parse(encodedKey);
      } catch {
        fail();
      }
      if (
        typeof key !== "string" ||
        JSON.stringify(key) !== encodedKey ||
        packages.has(key)
      ) {
        fail();
      }
      packages.add(key);
      current = {
        kind: "package",
        fields: new Set(),
        resolutions: 0,
      };
      continue;
    }
    const field = /^  ([A-Za-z][A-Za-z0-9]*):(.*)$/u.exec(rawLine);
    if (field) {
      if (!current || current.fields.has(field[1])) fail();
      current.fields.add(field[1]);
      if (current.kind === "metadata") {
        if (!new Set(["version", "cacheKey"]).has(field[1])) fail();
        continue;
      }
      if (!recordFields.has(field[1])) fail();
      if (field[1] === "resolution") {
        const encodedLocator = field[2].trim();
        let locator;
        try {
          locator = JSON.parse(encodedLocator);
        } catch {
          fail();
        }
        if (
          typeof locator !== "string" ||
          JSON.stringify(locator) !== encodedLocator ||
          !allowedLocator(locator)
        ) {
          fail();
        }
        current.resolutions += 1;
      } else if (/^[|>]/u.test(field[2].trim())) {
        fail();
      }
      continue;
    }
    if (!current || !/^ {4,}\S/u.test(rawLine)) fail();
  }
  finishBlock();
  if (!metadataSeen || packages.size === 0) fail();
}

function assertPackageManager(source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    fail();
  }
  if (manifest?.packageManager !== "yarn@4.13.0") fail();
  if (
    manifest.scripts !== undefined &&
    (manifest.scripts === null ||
      typeof manifest.scripts !== "object" ||
      Array.isArray(manifest.scripts))
  ) {
    fail();
  }
  if (
    Object.keys(manifest.scripts ?? {}).some((name) =>
      FORBIDDEN_ROOT_SCRIPTS.has(name),
    )
  ) {
    fail();
  }
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

async function assertAbsent(path, code = "dependency-sandbox") {
  try {
    await lstat(path);
    fail(code);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function resolveContext(operationId, options = {}) {
  if (!isCanonicalOperationId(operationId)) fail();
  const runtimeRoot = resolve(
    options.runtimeRoot ?? "/run/home-worker/prepare",
  );
  const releasesRoot = resolve(
    options.releasesRoot ?? "/opt/home-worker/releases",
  );
  const operationRoot = join(runtimeRoot, operationId);
  const receiptPath = join(runtimeRoot, `${operationId}.json`);
  const candidateProjection = join(operationRoot, "candidate");
  const temp = join(operationRoot, "tmp");
  const challengePath = join(temp, "coordinator-challenge.json");
  if (options.enforceRootOwnership ?? true) {
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
  const receiptBytes = await readStableFile(receiptPath, MAX_JSON_BYTES);
  const receipt = strictReceipt(decodeUtf8(receiptBytes), operationId);
  const releasesReal = await realpath(releasesRoot);
  const expectedCandidate = resolve(releasesReal, receipt.candidate);
  if (
    dirname(expectedCandidate) !== releasesReal ||
    basename(expectedCandidate) !== receipt.candidate
  ) {
    fail();
  }
  const candidate = await realpath(candidateProjection);
  if (
    candidate !== expectedCandidate ||
    (await realpath(expectedCandidate)) !== expectedCandidate
  ) {
    fail();
  }
  const candidateInfo = await lstat(candidate);
  if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) fail();
  let coordinatorChallenge = null;
  if (options.requireChallenge) {
    if (options.enforceRootOwnership ?? true) {
      await assertRootOwned(challengePath, "file");
    }
    const challenge = parseStrictJson(
      decodeUtf8(await readStableFile(challengePath, MAX_JSON_BYTES)),
      CHALLENGE_KEYS,
    );
    if (
      challenge.schemaVersion !== 1 ||
      challenge.operationId !== operationId ||
      !SHA256.test(challenge.challenge)
    ) {
      fail();
    }
    coordinatorChallenge = challenge.challenge;
  }
  return Object.freeze({
    operationId,
    runtimeRoot,
    releasesRoot: releasesReal,
    operationRoot,
    receiptPath,
    receipt,
    receiptSha256: sha256(receiptBytes),
    candidateProjection,
    candidate,
    temp,
    challengePath,
    coordinatorChallenge,
  });
}

async function snapshotPath(absolutePath, relativePath, records) {
  const before = await lstat(absolutePath, { bigint: true });
  if (before.isSymbolicLink()) fail();
  if (before.isFile()) {
    records.push(
      `f\0${relativePath}\0${before.mode & 0o7777n}\0${before.size}\0${await stableFileSha256(absolutePath)}`,
    );
    return;
  }
  if (!before.isDirectory()) fail();
  const handle = await open(
    absolutePath,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameIdentity(before, opened)) fail();
    records.push(`d\0${relativePath}\0${opened.mode & 0o7777n}`);
    const anchored =
      process.platform === "linux"
        ? `/proc/self/fd/${handle.fd}`
        : absolutePath;
    const entries = await readdir(anchored);
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    for (const name of entries) {
      const child =
        relativePath.length === 0 ? name : `${relativePath}/${name}`;
      if (GENERATED_PATHS.has(child)) continue;
      if (child === ".yarn/cache" || child.startsWith(".yarn/cache/")) fail();
      await snapshotPath(join(anchored, name), child, records);
    }
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(absolutePath, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(opened, finalPath))
      fail();
  } finally {
    await handle.close();
  }
}

async function archiveInputSha256(candidate) {
  const records = [];
  await snapshotPath(candidate, "", records);
  return sha256(`${records.join("\n")}\n`);
}

async function validateArchiveInputs(context) {
  const packageBytes = await readStableFile(
    join(context.candidate, "package.json"),
    MAX_JSON_BYTES,
  );
  const lockBytes = await readStableFile(
    join(context.candidate, "yarn.lock"),
    16 * 1024 * 1024,
  );
  const policyBytes = await readStableFile(
    join(context.candidate, ".yarnrc.yml"),
    MAX_JSON_BYTES,
  );
  const markerBytes = await readStableFile(
    join(context.candidate, "artifact-state.json"),
    MAX_JSON_BYTES,
  );
  assertPackageManager(decodeUtf8(packageBytes));
  validateLockLocators(decodeUtf8(lockBytes));
  assertYarnPolicy(decodeUtf8(policyBytes));
  assertCandidateMarker(decodeUtf8(markerBytes), context.receipt);
  await assertAbsent(join(context.candidate, ".yarn", "cache"));
  return Object.freeze({
    archiveInputSha256: await archiveInputSha256(context.candidate),
    yarnLockSha256: sha256(lockBytes),
    yarnRuntimeSha256: await stableFileSha256(
      join(context.candidate, YARN_RUNTIME_PATH),
    ),
  });
}

async function assertInstalledProjection(
  candidate,
  code = "dependency-install",
) {
  try {
    const projection = await lstat(join(candidate, "node_modules"));
    if (!projection.isDirectory() || projection.isSymbolicLink()) fail(code);
    await assertAbsent(join(candidate, ".yarn", "cache"), code);
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail(code);
  }
}

function phaseEnvironment(context, phase) {
  const home = join(context.temp, "home");
  const network = phase === "fetch";
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    TMPDIR: context.temp,
    TMP: context.temp,
    TEMP: context.temp,
    NODE_ENV: "production",
    NODE_OPTIONS: "--max-old-space-size=256",
    JOBS: "1",
    YARN_NETWORK_CONCURRENCY: "1",
    YARN_TASK_POOL_CONCURRENCY: "1",
    YARN_ENABLE_NETWORK: network ? "true" : "false",
    YARN_ENABLE_GLOBAL_CACHE: "false",
    YARN_ENABLE_IMMUTABLE_INSTALLS: "true",
    YARN_ENABLE_IMMUTABLE_CACHE: "false",
    YARN_ENABLE_SCRIPTS: network ? "false" : "true",
    YARN_CHECKSUM_BEHAVIOR: "throw",
    YARN_CACHE_FOLDER: join(context.temp, "yarn-cache"),
    YARN_NPM_REGISTRY_SERVER: "https://registry.npmjs.org",
    YARN_NPM_ALWAYS_AUTH: "false",
  });
}

async function fenceProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === "win32")
    return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("dependency process group did not terminate");
}

async function defaultRunner({ command, args, cwd, env }) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let settled = false;
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      try {
        await fenceProcessGroup(child.pid);
      } catch (fenceError) {
        rejectRun(fenceError);
        return;
      }
      if (error) rejectRun(error);
      else resolveRun();
    };
    child.once("error", (error) => void finish(error));
    child.once(
      "exit",
      (code, signal) =>
        void finish(
          code === 0 && signal === null
            ? undefined
            : new Error("dependency phase failed"),
        ),
    );
  });
}

async function syncDirectory(path) {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonDurably(path, value, mode = 0o600) {
  const parent = dirname(path);
  const tempPath = `${path}.${process.pid}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
  await syncDirectory(parent);
}

function fetchSentinelPath(context) {
  return join(context.temp, "fetch-sentinel.json");
}

function buildSentinelPath(context) {
  return join(context.temp, "build-sentinel.json");
}

function strictFetchSentinel(source, context) {
  const value = parseStrictJson(source, FETCH_SENTINEL_KEYS);
  if (
    value.schemaVersion !== 1 ||
    value.operationId !== context.operationId ||
    value.candidate !== context.receipt.candidate ||
    value.artifactSha256 !== context.receipt.artifactSha256 ||
    value.metadataSha256 !== context.receipt.metadataSha256 ||
    value.receiptSha256 !== context.receiptSha256 ||
    !SHA256.test(value.archiveInputSha256) ||
    !SHA256.test(value.yarnLockSha256) ||
    !SHA256.test(value.yarnRuntimeSha256) ||
    value.coordinatorChallenge !== context.coordinatorChallenge ||
    value.lifecycleScripts !== false
  ) {
    fail();
  }
  return value;
}

function strictBuildSentinel(source, context, archiveInputs) {
  const value = parseStrictJson(source, BUILD_SENTINEL_KEYS);
  if (
    value.schemaVersion !== 1 ||
    value.operationId !== context.operationId ||
    value.candidate !== context.receipt.candidate ||
    value.artifactSha256 !== context.receipt.artifactSha256 ||
    value.metadataSha256 !== context.receipt.metadataSha256 ||
    value.receiptSha256 !== context.receiptSha256 ||
    value.archiveInputSha256 !== archiveInputs.archiveInputSha256 ||
    !SHA256.test(value.preparedTreeSha256) ||
    !Number.isSafeInteger(value.preparedFiles) ||
    value.preparedFiles <= 0 ||
    !Number.isSafeInteger(value.preparedBytes) ||
    value.preparedBytes < 0 ||
    value.coordinatorChallenge !== context.coordinatorChallenge ||
    value.network !== false
  ) {
    fail();
  }
  return value;
}

export async function fetchDependencies(
  operationId,
  runner = defaultRunner,
  options = {},
) {
  try {
    const context = await resolveContext(operationId, {
      ...options,
      requireChallenge: true,
    });
    await mkdir(join(context.temp, "home"), { recursive: true, mode: 0o700 });
    await assertAbsent(join(context.candidate, "node_modules"));
    await assertAbsent(join(context.candidate, ".yarn", "install-state.gz"));
    const before = await validateArchiveInputs(context);
    await runner({
      command: "/usr/bin/node",
      args: [YARN_RUNTIME_PATH, "workspaces", "focus", "--all", "--production"],
      cwd: context.candidate,
      env: phaseEnvironment(context, "fetch"),
    });
    const after = await validateArchiveInputs(context);
    if (JSON.stringify(after) !== JSON.stringify(before))
      fail("dependency-install");
    await assertInstalledProjection(context.candidate);
    await writeJsonDurably(fetchSentinelPath(context), {
      schemaVersion: 1,
      operationId,
      candidate: context.receipt.candidate,
      artifactSha256: context.receipt.artifactSha256,
      metadataSha256: context.receipt.metadataSha256,
      receiptSha256: context.receiptSha256,
      ...after,
      coordinatorChallenge: context.coordinatorChallenge,
      lifecycleScripts: false,
    });
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail("dependency-install");
  }
}

async function measureTreePath(absolutePath, relativePath, records, totals) {
  const before = await lstat(absolutePath, { bigint: true });
  totals.entryCount += 1;
  totals.allocatedBytes += Number(before.blocks * 512n);
  if (
    totals.entryCount > MAX_PREPARED_FILES ||
    !Number.isSafeInteger(totals.allocatedBytes) ||
    totals.allocatedBytes > MAX_PREPARED_BYTES
  ) {
    fail("disk-resource");
  }
  if (before.isSymbolicLink()) {
    const target = await readlink(absolutePath, "buffer");
    const after = await lstat(absolutePath, { bigint: true });
    if (!sameIdentity(before, after)) fail("prepared-tree");
    records.push(
      `l\0${relativePath}\0${Buffer.from(target).toString("base64")}`,
    );
    return;
  }
  if (before.isFile()) {
    records.push(
      `f\0${relativePath}\0${before.mode & 0o7777n}\0${before.size}\0${await stableFileSha256(absolutePath)}`,
    );
    return;
  }
  if (!before.isDirectory()) fail("prepared-tree");
  records.push(`d\0${relativePath}\0${before.mode & 0o7777n}`);
  const entries = await readdir(absolutePath);
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  for (const name of entries) {
    await measureTreePath(
      join(absolutePath, name),
      relativePath.length === 0 ? name : `${relativePath}/${name}`,
      records,
      totals,
    );
  }
  const after = await lstat(absolutePath, { bigint: true });
  if (!sameIdentity(before, after)) fail("prepared-tree");
}

async function measureCandidate(candidate) {
  const records = [];
  const totals = { entryCount: 0, allocatedBytes: 0 };
  await measureTreePath(candidate, "", records, totals);
  return Object.freeze({
    ...totals,
    sha256: sha256(`${records.join("\n")}\n`),
  });
}

async function flushTree(path) {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink()) return;
  if (before.isFile()) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!sameIdentity(before, opened)) fail("prepared-tree");
      await handle.sync();
      const after = await handle.stat({ bigint: true });
      if (!sameIdentity(opened, after)) fail("prepared-tree");
    } finally {
      await handle.close();
    }
    return;
  }
  if (!before.isDirectory()) fail("prepared-tree");
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened)) fail("prepared-tree");
    const anchored =
      process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path;
    const entries = await readdir(anchored);
    for (const name of entries) await flushTree(join(anchored, name));
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(path, { bigint: true });
    if (!sameIdentity(opened, after) || !sameIdentity(opened, finalPath)) {
      fail("prepared-tree");
    }
  } finally {
    await handle.close();
  }
}

async function measureDurably(candidate) {
  const before = await measureCandidate(candidate);
  await flushTree(candidate);
  const after = await measureCandidate(candidate);
  if (JSON.stringify(after) !== JSON.stringify(before)) fail("prepared-tree");
  return after;
}

export async function buildDependencies(
  operationId,
  runner = defaultRunner,
  options = {},
) {
  try {
    const context = await resolveContext(operationId, {
      ...options,
      requireChallenge: true,
    });
    const sentinel = strictFetchSentinel(
      decodeUtf8(
        await readStableFile(fetchSentinelPath(context), MAX_JSON_BYTES),
      ),
      context,
    );
    const before = await validateArchiveInputs(context);
    if (
      before.archiveInputSha256 !== sentinel.archiveInputSha256 ||
      before.yarnLockSha256 !== sentinel.yarnLockSha256 ||
      before.yarnRuntimeSha256 !== sentinel.yarnRuntimeSha256
    ) {
      fail();
    }
    await assertInstalledProjection(context.candidate);
    await runner({
      command: "/usr/bin/node",
      args: [YARN_RUNTIME_PATH, "rebuild"],
      cwd: context.candidate,
      env: phaseEnvironment(context, "build"),
    });
    const after = await validateArchiveInputs(context);
    if (JSON.stringify(after) !== JSON.stringify(before))
      fail("dependency-install");
    await assertInstalledProjection(context.candidate);
    const prepared = await measureDurably(context.candidate);
    await writeJsonDurably(buildSentinelPath(context), {
      schemaVersion: 1,
      operationId,
      candidate: context.receipt.candidate,
      artifactSha256: context.receipt.artifactSha256,
      metadataSha256: context.receipt.metadataSha256,
      receiptSha256: context.receiptSha256,
      archiveInputSha256: after.archiveInputSha256,
      preparedTreeSha256: prepared.sha256,
      preparedFiles: prepared.entryCount,
      preparedBytes: prepared.allocatedBytes,
      coordinatorChallenge: context.coordinatorChallenge,
      network: false,
    });
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    fail("dependency-install");
  }
}

function systemctlProcess(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("/bin/systemctl", args, {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolveRun();
      else rejectRun(new Error("systemd dependency phase failed"));
    });
  });
}

async function defaultCoordinatorRunner({ unit }) {
  let interrupted = false;
  let stopping;
  const start = systemctlProcess(["start", "--wait", "--", unit]);
  const stopBeforeRelease = () => {
    interrupted = true;
    stopping ??= systemctlProcess(["stop", "--wait", "--", unit]);
  };
  process.once("SIGTERM", stopBeforeRelease);
  process.once("SIGINT", stopBeforeRelease);
  try {
    await start;
    if (interrupted) {
      await stopping;
      throw new Error("dependency coordinator interrupted");
    }
  } catch (error) {
    if (stopping) {
      try {
        await stopping;
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "dependency phase cancellation failed",
        );
      }
    }
    throw error;
  } finally {
    process.removeListener("SIGTERM", stopBeforeRelease);
    process.removeListener("SIGINT", stopBeforeRelease);
  }
}

async function invalidateFailedCandidate(context) {
  for (const entry of await readdir(context.candidateProjection)) {
    await rm(join(context.candidateProjection, entry), {
      recursive: true,
      force: true,
    });
  }
  if ((await readdir(context.candidateProjection)).length !== 0) {
    fail("dependency-install");
  }
  await syncDirectory(context.candidateProjection);
}

export async function coordinatePreparation(
  operationId,
  runner = defaultCoordinatorRunner,
  options = {},
) {
  let context;
  try {
    context = await resolveContext(operationId, options);
    for (const path of [
      fetchSentinelPath(context),
      buildSentinelPath(context),
      context.challengePath,
    ]) {
      await rm(path, { force: true });
    }
    await writeJsonDurably(
      context.challengePath,
      {
        schemaVersion: 1,
        operationId,
        challenge: randomBytes(32).toString("hex"),
      },
      0o644,
    );
    context = await resolveContext(operationId, {
      ...options,
      requireChallenge: true,
    });
    for (const phase of ["fetch", "build"]) {
      await runner({
        phase,
        unit: `home-worker-ota-deps-${phase}@${operationId}.service`,
      });
    }
    const after = await validateArchiveInputs(context);
    strictBuildSentinel(
      decodeUtf8(
        await readStableFile(buildSentinelPath(context), MAX_JSON_BYTES),
      ),
      context,
      after,
    );
  } catch (error) {
    if (context) {
      try {
        await invalidateFailedCandidate(context);
      } catch {
        fail("dependency-install");
      }
    }
    if (error instanceof PreparationError) throw error;
    fail("dependency-install");
  }
}

async function main() {
  if (process.argv.length !== 4) fail();
  const [, , phase, operationId] = process.argv;
  if (phase === "coordinate") await coordinatePreparation(operationId);
  else if (phase === "fetch") await fetchDependencies(operationId);
  else if (phase === "build") await buildDependencies(operationId);
  else fail();
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code =
      error instanceof PreparationError ? error.code : "dependency-sandbox";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
