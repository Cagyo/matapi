import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { inspectCacheInventory } from "../../installer/ota-prepare.mjs";
import { createDeterministicTarGz } from "./archive-writer.mjs";
import {
  parseBuilderPolicy,
  validateBuilderPolicyOwnership,
} from "./builder-policy.mjs";
import {
  bytewiseCompare,
  computeCacheInventorySha256,
} from "./release-policy.mjs";

const RELEASE_FILES = Object.freeze([
  "package.json",
  "yarn.lock",
  "config/defaults.yml",
  "scripts/rollback.sh",
  "scripts/system-update.sh",
  "scripts/update.sh",
]);
const RELEASE_DIRECTORIES = Object.freeze(["dist", "migrations"]);
const RELEASE_YARN_POLICY = [
  "nodeLinker: node-modules",
  "enableGlobalCache: false",
  "enableNetwork: false",
  "enableImmutableInstalls: true",
  "enableImmutableCache: true",
  "cacheFolder: .yarn/cache",
  "yarnPath: .yarn/releases/yarn-4.13.0.cjs",
  "",
].join("\n");
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const ALLOWED_COMMANDS = Object.freeze({
  "install-development": [
    "/usr/bin/corepack",
    ["yarn", "install", "--immutable"],
  ],
  test: ["/usr/bin/corepack", ["yarn", "test"]],
  build: ["/usr/bin/corepack", ["yarn", "build"]],
  "pin-yarn": [
    "/usr/bin/corepack",
    ["yarn", "set", "version", "4.13.0", "--yarn-path"],
  ],
  "focus-production-online": [
    "/usr/bin/node",
    [
      ".yarn/releases/yarn-4.13.0.cjs",
      "workspaces",
      "focus",
      "-A",
      "--production",
    ],
  ],
  "focus-production-offline": [
    "/usr/bin/node",
    [
      ".yarn/releases/yarn-4.13.0.cjs",
      "workspaces",
      "focus",
      "-A",
      "--production",
    ],
  ],
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function separated(left, right) {
  return (
    left !== right &&
    !left.startsWith(`${right}${sep}`) &&
    !right.startsWith(`${left}${sep}`)
  );
}

export function validateClonedTag({ tagKind, tagCommit, commit }) {
  if (tagKind !== "tag") {
    throw new Error(
      "Release reference must remain an annotated tag in the clone",
    );
  }
  if (tagCommit !== commit) {
    throw new Error("Release tag must resolve to the exact requested commit");
  }
}

async function absent(path, description) {
  try {
    await lstat(path);
    throw new Error(`${description} already exists: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function ensureRealDirectory(path, description) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${description} must be a real directory`);
  }
}

async function copyClosedTree(source, destination, executable = false) {
  const info = await lstat(source, { bigint: true });
  if (info.isSymbolicLink())
    throw new Error(`Release input contains a symbolic link: ${source}`);
  if (info.isDirectory()) {
    const handle = await open(
      source,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isDirectory() || !sameIdentity(info, opened)) {
        throw new Error(`Release directory changed while opening: ${source}`);
      }
      const anchoredSource =
        process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : source;
      await mkdir(destination, { mode: 0o755 });
      const entries = await readdir(anchoredSource, { withFileTypes: true });
      entries.sort((left, right) => bytewiseCompare(left.name, right.name));
      for (const entry of entries) {
        await copyClosedTree(
          join(anchoredSource, entry.name),
          join(destination, entry.name),
          executable,
        );
      }
      const after = await handle.stat({ bigint: true });
      if (!sameIdentity(opened, after)) {
        throw new Error(`Release directory changed while copying: ${source}`);
      }
    } finally {
      await handle.close();
    }
    return;
  }
  if (!info.isFile())
    throw new Error(`Release input is not a regular file: ${source}`);
  const sourceHandle = await open(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let destinationHandle;
  try {
    const opened = await sourceHandle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(info, opened)) {
      throw new Error(`Release file changed while opening: ${source}`);
    }
    if (opened.size > 64n * 1024n * 1024n) {
      throw new Error(`Release file exceeds the per-file limit: ${source}`);
    }
    destinationHandle = await open(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.chmod(executable ? 0o755 : 0o644);
    await destinationHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if (!sameIdentity(opened, after) || BigInt(position) !== opened.size) {
      throw new Error(`Release input changed while copying: ${source}`);
    }
  } finally {
    if (destinationHandle) await destinationHandle.close();
    await sourceHandle.close();
  }
}

async function runProcess(command, args, options) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let length = 0;
    const collect = (chunks) => (chunk) => {
      length += chunk.length;
      if (length > MAX_COMMAND_OUTPUT) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdoutChunks));
    child.stderr.on("data", collect(stderrChunks));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const output = [stdout, stderr].filter(Boolean).join("\n");
      if (length > MAX_COMMAND_OUTPUT) {
        reject(new Error(`${options.phase} exceeded the command output limit`));
      } else if (code !== 0 || signal !== null) {
        reject(
          new Error(`${options.phase} failed${output ? `: ${output}` : ""}`),
        );
      } else {
        resolvePromise(stdout);
      }
    });
  });
}

export async function prepareIsolatedCommandEnvironment(env) {
  const stateRoot = dirname(env?.HOME ?? "");
  const expected = {
    HOME: join(stateRoot, "home"),
    XDG_CACHE_HOME: join(stateRoot, "home/.cache"),
    XDG_CONFIG_HOME: join(stateRoot, "home/.config"),
    TMPDIR: join(stateRoot, "tmp"),
    TMP: join(stateRoot, "tmp"),
    TEMP: join(stateRoot, "tmp"),
    COREPACK_HOME: join(stateRoot, "corepack"),
  };
  if (
    !stateRoot.startsWith("/") ||
    Object.entries(expected).some(([key, value]) => env?.[key] !== value)
  ) {
    throw new Error("Release command state paths are not isolated");
  }
  for (const path of new Set(Object.values(expected))) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await ensureRealDirectory(path, "Release command state path");
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function stableDirectoryIdentity(path, description) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${description} must be a real directory`);
  }
  return Object.freeze({
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
  });
}

function sameDirectoryIdentity(left, right) {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

async function verifyRootGuard(guard) {
  if (!guard) return;
  const sourceIdentity = await stableDirectoryIdentity(
    guard.sourceRoot,
    "Guarded source root",
  );
  const outputIdentity = await stableDirectoryIdentity(
    guard.outputRoot,
    "Guarded output root",
  );
  const workParentIdentity = await stableDirectoryIdentity(
    guard.workParent,
    "Guarded work parent",
  );
  if (
    !sameDirectoryIdentity(sourceIdentity, guard.sourceIdentity) ||
    !sameDirectoryIdentity(outputIdentity, guard.outputIdentity) ||
    !sameDirectoryIdentity(workParentIdentity, guard.workParentIdentity) ||
    (await realpath(guard.sourceRoot)) !== guard.sourceRoot ||
    (await realpath(guard.outputRoot)) !== guard.outputRoot ||
    (await realpath(guard.workRoot)) !== guard.workRoot ||
    !separated(guard.sourceRoot, guard.outputRoot) ||
    !separated(guard.sourceRoot, guard.workRoot) ||
    !separated(guard.outputRoot, guard.workRoot)
  ) {
    throw new Error("Candidate root identity or separation changed");
  }
}

async function writeTemporary(parent, name, bytes) {
  const path = join(
    parent,
    `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o644);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

export async function readRootOwnedBuilderPolicy(path) {
  const requested = resolve(path);
  const before = await lstat(requested, { bigint: true });
  validateBuilderPolicyOwnership(before);
  const handle = await open(
    requested,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened))
      throw new Error("Builder policy changed while opening");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(opened, after))
      throw new Error("Builder policy changed while reading");
    return parseBuilderPolicy(bytes);
  } finally {
    await handle.close();
  }
}

export async function publishCandidatePair(input) {
  await verifyRootGuard(input.rootGuard);
  const parent = await realpath(resolve(input.outputRoot));
  if (input.rootGuard && parent !== input.rootGuard.outputRoot) {
    throw new Error("Candidate output root changed after validation");
  }
  await ensureRealDirectory(parent, "Candidate output root");
  for (const name of [input.archiveName, input.descriptorName]) {
    if (name !== basename(name) || name.includes(sep) || name.startsWith(".")) {
      throw new Error("Candidate output name is unsafe");
    }
  }
  if (
    !Buffer.isBuffer(input.archiveBytes) ||
    !Buffer.isBuffer(input.descriptorBytes)
  ) {
    throw new TypeError("Candidate outputs must be buffers");
  }
  const archivePath = join(parent, input.archiveName);
  const descriptorPath = join(parent, input.descriptorName);
  const directoryHandle = await open(
    parent,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  const directoryInfo = await directoryHandle.stat({ bigint: true });
  if (
    !directoryInfo.isDirectory() ||
    (input.rootGuard &&
      !sameDirectoryIdentity(directoryInfo, input.rootGuard.outputIdentity))
  ) {
    await directoryHandle.close();
    throw new Error("Candidate output directory identity changed");
  }
  const anchoredParent =
    process.platform === "linux"
      ? `/proc/self/fd/${directoryHandle.fd}`
      : parent;
  const tempPaths = [];
  const linkedPaths = [];
  try {
    await absent(join(anchoredParent, input.archiveName), "Candidate output");
    await absent(
      join(anchoredParent, input.descriptorName),
      "Candidate output",
    );
    tempPaths.push(
      await writeTemporary(
        anchoredParent,
        input.archiveName,
        input.archiveBytes,
      ),
    );
    tempPaths.push(
      await writeTemporary(
        anchoredParent,
        input.descriptorName,
        input.descriptorBytes,
      ),
    );
    const anchoredArchive = join(anchoredParent, input.archiveName);
    const anchoredDescriptor = join(anchoredParent, input.descriptorName);
    await link(tempPaths[0], anchoredArchive);
    linkedPaths.push(anchoredArchive);
    if (input.faultInjection === "after-archive-link") {
      throw new Error("Injected publication failure after archive link");
    }
    await link(tempPaths[1], anchoredDescriptor);
    linkedPaths.push(anchoredDescriptor);
    for (const path of tempPaths) await unlink(path);
    tempPaths.length = 0;
    await directoryHandle.sync();
    await verifyRootGuard(input.rootGuard);
  } catch (error) {
    const cleanupErrors = [];
    for (const path of [...tempPaths, ...linkedPaths]) {
      try {
        await unlink(path);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") cleanupErrors.push(cleanupError);
      }
    }
    try {
      await directoryHandle.sync();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Candidate pair publication compensation failed",
      );
    }
    throw error;
  } finally {
    await directoryHandle.close();
  }
  return Object.freeze({
    archivePath,
    descriptorPath,
    archiveSha256: sha256(input.archiveBytes),
    descriptorSha256: sha256(input.descriptorBytes),
  });
}

export function createNodeCandidateDependencies() {
  return Object.freeze({
    async resolveBuildRoots({ sourceRoot, workRoot, outputRoot }) {
      const canonicalSource = await realpath(resolve(sourceRoot));
      const canonicalOutput = await realpath(resolve(outputRoot));
      await ensureRealDirectory(canonicalSource, "Source root");
      await ensureRealDirectory(canonicalOutput, "Candidate output root");
      const requestedWork = resolve(workRoot);
      await absent(requestedWork, "Work root");
      const workParent = await realpath(dirname(requestedWork));
      const canonicalWork = join(workParent, basename(requestedWork));
      if (
        !separated(canonicalSource, canonicalOutput) ||
        !separated(canonicalSource, canonicalWork) ||
        !separated(canonicalOutput, canonicalWork)
      ) {
        throw new Error(
          "Canonical source, work, and output roots must be separate",
        );
      }
      return Object.freeze({
        sourceRoot: canonicalSource,
        workRoot: canonicalWork,
        outputRoot: canonicalOutput,
        rootGuard: Object.freeze({
          sourceRoot: canonicalSource,
          workRoot: canonicalWork,
          workParent,
          outputRoot: canonicalOutput,
          sourceIdentity: await stableDirectoryIdentity(
            canonicalSource,
            "Source root",
          ),
          workParentIdentity: await stableDirectoryIdentity(
            workParent,
            "Work parent",
          ),
          outputIdentity: await stableDirectoryIdentity(
            canonicalOutput,
            "Candidate output root",
          ),
        }),
      });
    },

    async prepareBuildCheckout({ sourceRoot, buildRoot, commit, tag }) {
      await ensureRealDirectory(sourceRoot, "Source root");
      const workRoot = dirname(buildRoot);
      await absent(workRoot, "Work root");
      const workParent = dirname(workRoot);
      if ((await realpath(workParent)) !== workParent) {
        throw new Error("Work root parent must not traverse a symbolic link");
      }
      await mkdir(workRoot, { mode: 0o700 });
      await runProcess(
        "/usr/bin/git",
        [
          "clone",
          "--no-hardlinks",
          "--no-checkout",
          "--",
          sourceRoot,
          buildRoot,
        ],
        {
          phase: "clone-source",
          cwd: dirname(buildRoot),
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
        },
      );
      await runProcess("/usr/bin/git", ["checkout", "--detach", commit], {
        phase: "checkout-source",
        cwd: buildRoot,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      });
      const tagKind = await runProcess(
        "/usr/bin/git",
        ["cat-file", "-t", `refs/tags/${tag}`],
        {
          phase: "verify-tag-kind",
          cwd: buildRoot,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
        },
      );
      const tagCommit = await runProcess(
        "/usr/bin/git",
        ["rev-parse", "--verify", `${tag}^{commit}`],
        {
          phase: "verify-tag-commit",
          cwd: buildRoot,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
        },
      );
      validateClonedTag({ tagKind, tagCommit, commit });
    },

    async prepareAssembly({ buildRoot, assemblyRoot }) {
      await ensureRealDirectory(buildRoot, "Build root");
      await absent(assemblyRoot, "Assembly root");
      await mkdir(assemblyRoot, { recursive: true, mode: 0o700 });
      for (const path of RELEASE_FILES) {
        await mkdir(dirname(join(assemblyRoot, path)), {
          recursive: true,
          mode: 0o755,
        });
        await copyClosedTree(
          join(buildRoot, path),
          join(assemblyRoot, path),
          path.startsWith("scripts/"),
        );
      }
      for (const path of RELEASE_DIRECTORIES) {
        try {
          await copyClosedTree(join(buildRoot, path), join(assemblyRoot, path));
        } catch (error) {
          if (path !== "migrations" || error.code !== "ENOENT") throw error;
        }
      }
    },

    async removeProductionProjection({ assemblyRoot }) {
      const root = await realpath(resolve(assemblyRoot));
      const projection = join(root, "node_modules");
      await ensureRealDirectory(projection, "Production dependency projection");
      await rm(projection, { recursive: true });
      const installState = join(root, ".yarn/install-state.gz");
      try {
        const info = await lstat(installState);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error("Yarn install state path is unsafe");
        }
        await unlink(installState);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },

    async sealReleaseConfig({ assemblyRoot }) {
      const root = await realpath(resolve(assemblyRoot));
      const releasePath = join(root, ".yarn/releases/yarn-4.13.0.cjs");
      const release = await lstat(releasePath);
      if (!release.isFile() || release.isSymbolicLink())
        throw new Error("Pinned Yarn release is absent or unsafe");
      const destination = join(root, ".yarnrc.yml");
      try {
        const existing = await lstat(destination);
        if (!existing.isFile() || existing.isSymbolicLink())
          throw new Error("Yarn policy path is unsafe");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const temp = join(
        root,
        `.yarnrc.yml.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
      );
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(RELEASE_YARN_POLICY, "utf8");
        await handle.chmod(0o644);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, destination);
      await syncDirectory(root);
    },

    async prepareValidationCopy({ assemblyRoot, validationRoot }) {
      await absent(validationRoot, "Validation root");
      await copyClosedTree(assemblyRoot, validationRoot);
    },

    async run({ phase, command, args, cwd, env }) {
      const allowed = ALLOWED_COMMANDS[phase];
      if (
        !allowed ||
        command !== allowed[0] ||
        JSON.stringify(args) !== JSON.stringify(allowed[1])
      ) {
        throw new Error(`Refusing unexpected release command: ${phase}`);
      }
      await prepareIsolatedCommandEnvironment(env);
      await runProcess(command, args, { phase, cwd, env });
    },

    async inspectCache(root) {
      const inspected = await inspectCacheInventory(join(root, ".yarn/cache"));
      const inventory = inspected.archives.map((entry) => ({
        path: `.yarn/cache/${entry.path}`,
        size: entry.size,
        sha256: entry.sha256,
      }));
      return Object.freeze({
        inventory,
        sha256: computeCacheInventorySha256(inventory),
      });
    },

    async createArchive({
      assemblyRoot,
      sourceDateEpoch,
      expectedCacheInventory,
    }) {
      return createDeterministicTarGz({
        root: assemblyRoot,
        sourceDateEpoch,
        expectedCacheInventory,
      });
    },

    publish: publishCandidatePair,
  });
}
