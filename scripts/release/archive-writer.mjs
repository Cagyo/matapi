import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  link,
  lstat,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { bytewiseCompare } from "./release-policy.mjs";

const BLOCK_SIZE = 512;
const MAX_PATH_BYTES = 240;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const REQUIRED_FILES = new Set([
  ".yarn/releases/yarn-4.13.0.cjs",
  ".yarnrc.yml",
  "config/defaults.yml",
  "dist/main.js",
  "package.json",
  "scripts/rollback.sh",
  "scripts/system-update.sh",
  "scripts/update.sh",
  "yarn.lock",
]);
const OPERATIONAL_SCRIPTS = new Set([
  "scripts/rollback.sh",
  "scripts/system-update.sh",
  "scripts/update.sh",
]);
const EXACT_FILES = new Set([
  ".yarn/releases/yarn-4.13.0.cjs",
  ".yarnrc.yml",
  "config/defaults.yml",
  "package.json",
  ...OPERATIONAL_SCRIPTS,
  "yarn.lock",
]);
const EXACT_DIRECTORIES = new Set([
  ".yarn",
  ".yarn/releases",
  "config",
  "dist",
  "migrations",
  "scripts",
]);
const DENIED_SEGMENTS = new Set([
  ".git",
  "data",
  "dev",
  "docs",
  "media",
  "node_modules",
  "src",
  "test",
  "tests",
]);
const UPDATER_MARKERS = new Set([
  "artifact-state.json",
  "artifact-envelope.json",
  "known-good.json",
]);
const DENIED_EXTENSIONS =
  /\.(?:db|db-shm|db-wal|sqlite|sqlite3|log|pem|key|p12|mp4|avi|mkv|jpe?g|png)$/iu;
function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function decodeName(name) {
  if (typeof name === "string") return name;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(name);
  } catch {
    throw new Error("Release tree contains a non-UTF-8 path");
  }
}

function assertSafeRelativePath(path) {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(path) ||
    path
      .split("/")
      .some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES
  ) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
}

function isDenied(path) {
  const segments = path.split("/");
  return (
    segments.some(
      (segment) =>
        DENIED_SEGMENTS.has(segment) ||
        UPDATER_MARKERS.has(segment) ||
        segment.startsWith(".env"),
    ) || DENIED_EXTENSIONS.test(path)
  );
}

function isAllowedDirectory(path) {
  return (
    EXACT_DIRECTORIES.has(path) ||
    path.startsWith("dist/") ||
    path.startsWith("migrations/")
  );
}

function isAllowedFile(path) {
  return (
    EXACT_FILES.has(path) ||
    path.startsWith("dist/") ||
    /^migrations\/(?:.+\/)*[^/]+\.sql$/u.test(path) ||
    /^migrations\/meta\/(?:.+\/)*[^/]+\.json$/u.test(path)
  );
}

async function readStableFile(
  absolutePath,
  relativePath,
  expectedSize,
  expectedStat,
) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size !== BigInt(expectedSize) ||
      !sameFileIdentity(before, expectedStat)
    ) {
      throw new Error(
        `Release file changed during inspection: ${relativePath}`,
      );
    }
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || !sameFileIdentity(after, before)) {
      throw new Error(
        `Release file changed during inspection: ${relativePath}`,
      );
    }
    return contents;
  } finally {
    await handle.close();
  }
}

export async function inspectReleaseTree({ root }) {
  const rootPath = await realpath(resolve(root));
  const rootStat = await lstat(rootPath, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Release root must be a real directory");
  }

  const entries = [];
  let expandedBytes = 0;
  const walk = async (directory, parent = "", expectedStat = rootStat) => {
    const flags =
      constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0);
    const directoryHandle = await open(directory, flags);
    try {
      const before = await directoryHandle.stat({ bigint: true });
      if (
        !before.isDirectory() ||
        before.dev !== expectedStat.dev ||
        before.ino !== expectedStat.ino
      ) {
        throw new Error("Release directory changed during inspection");
      }
      // Linux release builders traverse through the opened directory identity.
      // Darwin is fixture-only and lacks a traversable directory-fd namespace.
      const anchoredDirectory =
        process.platform === "linux"
          ? `/proc/self/fd/${directoryHandle.fd}`
          : directory;
      const children = await readdir(anchoredDirectory, {
        withFileTypes: true,
        encoding: "buffer",
      });
      const named = children.map((child) => ({
        child,
        name: decodeName(child.name),
      }));
      named.sort((left, right) => bytewiseCompare(left.name, right.name));

      for (const { name } of named) {
        const path = parent ? `${parent}/${name}` : name;
        assertSafeRelativePath(path);
        if (isDenied(path)) throw new Error(`Denied release path: ${path}`);
        const anchoredPath = join(anchoredDirectory, name);
        const stat = await lstat(anchoredPath, { bigint: true });
        if (stat.isSymbolicLink()) {
          throw new Error(`Release tree contains a symbolic link: ${path}`);
        }
        if (!stat.isDirectory() && !stat.isFile()) {
          throw new Error(`Release tree contains a special file: ${path}`);
        }
        if ((stat.mode & 0o7022n) !== 0n) {
          throw new Error(`Release tree contains an unsafe mode: ${path}`);
        }
        if (stat.isDirectory()) {
          if (!isAllowedDirectory(path)) {
            throw new Error(
              `Directory is outside the release allowlist: ${path}`,
            );
          }
          entries.push({
            path,
            type: "directory",
            mode: 0o755,
            uid: 0,
            gid: 0,
            size: 0,
            sha256: null,
            contents: null,
          });
          await walk(anchoredPath, path, stat);
        } else {
          if (!isAllowedFile(path)) {
            throw new Error(`File is outside the release allowlist: ${path}`);
          }
          const size = Number(stat.size);
          if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) {
            throw new Error(`Release file exceeds the size limit: ${path}`);
          }
          expandedBytes += size;
          if (expandedBytes > MAX_TOTAL_BYTES) {
            throw new Error("Release tree exceeds the expanded size limit");
          }
          const contents = await readStableFile(anchoredPath, path, size, stat);
          entries.push({
            path,
            type: "file",
            mode: OPERATIONAL_SCRIPTS.has(path) ? 0o755 : 0o644,
            uid: 0,
            gid: 0,
            size,
            sha256: sha256(contents),
            contents,
          });
        }
        if (entries.length > MAX_ENTRIES) {
          throw new Error("Release tree exceeds the entry limit");
        }
      }
      const after = await directoryHandle.stat({ bigint: true });
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      ) {
        throw new Error("Release directory changed during inspection");
      }
    } finally {
      await directoryHandle.close();
    }
  };
  await walk(rootPath);

  const paths = new Set(entries.map((entry) => entry.path));
  for (const required of REQUIRED_FILES) {
    if (!paths.has(required))
      throw new Error(`Missing required release file: ${required}`);
  }
  entries.sort((left, right) => bytewiseCompare(left.path, right.path));
  return entries;
}

function writeOctal(header, offset, length, value) {
  const digits = value.toString(8);
  if (digits.length > length - 1)
    throw new Error("USTAR numeric field overflow");
  header.write(
    `${digits.padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii",
  );
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (
    let index = path.lastIndexOf("/");
    index > 0;
    index = path.lastIndexOf("/", index - 1)
  ) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Path cannot be represented in USTAR: ${path}`);
}

function tarHeader(entry, sourceDateEpoch) {
  const header = Buffer.alloc(BLOCK_SIZE);
  const { name, prefix } = splitUstarPath(entry.path);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.type === "file" ? entry.size : 0);
  writeOctal(header, 136, 12, sourceDateEpoch);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 0x35 : 0x30;
  header.write("ustar\0", 257, 6, "binary");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function inventoryOf(entries, sourceDateEpoch) {
  return entries.map(({ path, type, mode, uid, gid, size, sha256 }) => ({
    path,
    type,
    mode,
    uid,
    gid,
    mtime: sourceDateEpoch,
    size,
    sha256,
  }));
}

function buildTar(entries, sourceDateEpoch) {
  const chunks = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry, sourceDateEpoch));
    if (entry.type === "file") {
      chunks.push(entry.contents);
      const padding = (BLOCK_SIZE - (entry.size % BLOCK_SIZE)) % BLOCK_SIZE;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function deterministicGzip(tar) {
  const bytes = gzipSync(tar, { level: 9, mtime: 0 });
  bytes.fill(0, 4, 8);
  bytes[9] = 0xff;
  return bytes;
}

function readString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function readOctal(buffer, offset, length) {
  const value = readString(buffer, offset, length).trim();
  if (!/^[0-7]+$/u.test(value))
    throw new Error("Archive contains an invalid octal field");
  return Number.parseInt(value, 8);
}

function sameInventory(actual, expected) {
  if (!Array.isArray(expected) || actual.length !== expected.length)
    return false;
  return actual.every((entry, index) => {
    const wanted = expected[index];
    return (
      wanted &&
      entry.path === wanted.path &&
      entry.type === wanted.type &&
      entry.mode === wanted.mode &&
      entry.uid === wanted.uid &&
      entry.gid === wanted.gid &&
      entry.mtime === wanted.mtime &&
      entry.size === wanted.size &&
      entry.sha256 === wanted.sha256
    );
  });
}

export function validateDeterministicTarGz({
  bytes,
  sourceDateEpoch,
  expectedInventory,
}) {
  if (!Buffer.isBuffer(bytes))
    throw new TypeError("Archive bytes must be a Buffer");
  if (
    bytes.length < 10 ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b ||
    bytes.readUInt32LE(4) !== 0 ||
    bytes[9] !== 0xff
  ) {
    throw new Error("Archive does not use the deterministic gzip header");
  }
  const tar = gunzipSync(bytes);
  const inventory = [];
  let offset = 0;
  let previousPath = null;
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      const trailer = tar.subarray(offset);
      if (
        trailer.length !== BLOCK_SIZE * 2 ||
        !trailer.every((byte) => byte === 0)
      ) {
        throw new Error("Archive has an invalid end marker");
      }
      offset = tar.length;
      break;
    }
    if (readString(header, 257, 6) !== "ustar") {
      throw new Error("Archive entry is not USTAR");
    }
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const expectedChecksum = checksumHeader.reduce(
      (sum, byte) => sum + byte,
      0,
    );
    if (readOctal(header, 148, 8) !== expectedChecksum) {
      throw new Error("Archive entry has an invalid checksum");
    }
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    assertSafeRelativePath(path);
    if (isDenied(path))
      throw new Error(`Archive contains a denied path: ${path}`);
    if (previousPath !== null && bytewiseCompare(previousPath, path) >= 0) {
      throw new Error("Archive paths are not in canonical bytewise order");
    }
    previousPath = path;
    const typeFlag = header[156];
    if (typeFlag !== 0x30 && typeFlag !== 0x35) {
      throw new Error("Archive contains a link or special entry");
    }
    const type = typeFlag === 0x35 ? "directory" : "file";
    const mode = readOctal(header, 100, 8);
    const uid = readOctal(header, 108, 8);
    const gid = readOctal(header, 116, 8);
    const size = readOctal(header, 124, 12);
    const mtime = readOctal(header, 136, 12);
    if (
      uid !== 0 ||
      gid !== 0 ||
      mtime !== sourceDateEpoch ||
      (type === "directory"
        ? mode !== 0o755 || size !== 0
        : mode !== 0o644 && mode !== 0o755)
    ) {
      throw new Error(`Archive entry has noncanonical metadata: ${path}`);
    }
    offset += BLOCK_SIZE;
    if (offset + size > tar.length)
      throw new Error("Archive entry is truncated");
    const contents = tar.subarray(offset, offset + size);
    inventory.push({
      path,
      type,
      mode,
      uid,
      gid,
      mtime,
      size,
      sha256: type === "file" ? sha256(contents) : null,
    });
    offset += size;
    offset += (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
  }
  if (offset !== tar.length)
    throw new Error("Archive is missing its end marker");
  if (!sameInventory(inventory, expectedInventory)) {
    throw new Error(
      "Archive inventory differs from the validated source inventory",
    );
  }
  return inventory;
}

export async function createDeterministicTarGz({ root, sourceDateEpoch }) {
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new TypeError("SOURCE_DATE_EPOCH must be a nonnegative integer");
  }
  const entries = await inspectReleaseTree({ root });
  const inventory = inventoryOf(entries, sourceDateEpoch);
  const bytes = deterministicGzip(buildTar(entries, sourceDateEpoch));
  validateDeterministicTarGz({
    bytes,
    sourceDateEpoch,
    expectedInventory: inventory,
  });
  return Object.freeze({
    bytes,
    inventory: Object.freeze(inventory.map((entry) => Object.freeze(entry))),
    sha256: sha256(bytes),
    label: "synthetic-fixture-only",
  });
}

async function syncDirectory(path) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeDeterministicArchive({
  root,
  outputPath,
  sourceDateEpoch,
  faultInjection,
}) {
  if (
    faultInjection !== undefined &&
    faultInjection !== "after-link" &&
    faultInjection !== "before-parent-fsync"
  ) {
    throw new TypeError("Unknown archive publication fault injection");
  }
  if (!isAbsolute(outputPath))
    throw new TypeError("Archive output path must be absolute");
  const requestedParent = dirname(outputPath);
  const parent = await realpath(requestedParent);
  const canonicalOutputPath = join(parent, basename(outputPath));
  try {
    await lstat(canonicalOutputPath);
    throw new Error(`Archive output already exists: ${canonicalOutputPath}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const archive = await createDeterministicTarGz({
    root,
    sourceDateEpoch,
  });
  const tempPath = join(
    parent,
    `.${basename(outputPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  if (tempPath.includes(`${sep}..${sep}`))
    throw new Error("Unsafe archive temporary path");
  let handle;
  let finalLinked = false;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(archive.bytes);
    await handle.chmod(0o644);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(tempPath, canonicalOutputPath);
    finalLinked = true;
    if (faultInjection === "after-link") {
      throw new Error("Injected publication failure after link");
    }
    await unlink(tempPath);
    if (faultInjection === "before-parent-fsync") {
      throw new Error("Injected publication failure before parent fsync");
    }
    await syncDirectory(parent);
  } catch (error) {
    const cleanupErrors = [];
    if (handle) {
      try {
        await handle.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") cleanupErrors.push(cleanupError);
    }
    if (finalLinked) {
      try {
        await unlink(canonicalOutputPath);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") cleanupErrors.push(cleanupError);
      }
      try {
        await syncDirectory(parent);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Archive publication failed and compensation was incomplete",
      );
    }
    throw error;
  }
  return Object.freeze({
    outputPath: canonicalOutputPath,
    sha256: archive.sha256,
    inventory: archive.inventory,
    label: archive.label,
  });
}
