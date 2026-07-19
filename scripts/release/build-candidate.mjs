#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_TARGETS,
  bytewiseCompare,
  evaluateReleasePolicy,
} from "./release-policy.mjs";

const EXIT_USAGE = 64;
const EXIT_NONPUBLISHABLE = 75;
const REQUIRED_OPTIONS = Object.freeze([
  "version",
  "commit",
  "tag",
  "target",
  "source",
  "output",
  "builder-attestation",
]);

function usage(message) {
  if (message) process.stderr.write(`ERROR ${message}\n`);
  process.stderr.write(
    "Usage: build-candidate.mjs --version X.Y.Z --commit 40HEX --tag vX.Y.Z " +
      "--target linux-arm64-glibc|linux-armv7-glibc --source ABSOLUTE_PATH " +
      "--output ABSOLUTE_PATH --builder-attestation ABSOLUTE_PATH\n",
  );
  process.exit(EXIT_USAGE);
}

function refuse(reasons) {
  const stable = [...new Set(reasons)].sort(bytewiseCompare);
  process.stderr.write(`NONPUBLISHABLE ${stable.join(",")}\n`);
  process.exit(EXIT_NONPUBLISHABLE);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      usage("options must be supplied as --name value pairs");
    }
    const name = flag.slice(2);
    if (!REQUIRED_OPTIONS.includes(name) || Object.hasOwn(options, name)) {
      usage(`unknown or duplicate option: ${flag}`);
    }
    options[name] = value;
  }
  const missing = REQUIRED_OPTIONS.filter(
    (name) => !Object.hasOwn(options, name),
  );
  if (missing.length > 0) usage(`missing options: ${missing.join(", ")}`);
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(options.version)
  ) {
    usage("version must be a stable semantic version");
  }
  if (!/^[0-9a-f]{40}$/u.test(options.commit))
    usage("commit must be lowercase 40-hex");
  if (options.tag !== `v${options.version}`)
    usage("tag must exactly match the version");
  if (!Object.hasOwn(RELEASE_TARGETS, options.target))
    usage("unsupported release target");
  if (!options.source.startsWith("/") || !options.output.startsWith("/")) {
    usage("source and output paths must be absolute");
  }
  if (!options["builder-attestation"].startsWith("/")) {
    usage("builder attestation path must be absolute");
  }
  return Object.freeze(options);
}

function actualHostFacts() {
  const report = process.report?.getReport();
  return Object.freeze({
    platform: process.platform,
    arch: process.arch,
    armVersion: Number(process.config.variables.arm_version) || null,
    libc: report?.header?.glibcVersionRuntime ? "glibc" : "unknown",
    nodeMajor: Number.parseInt(process.versions.node.split(".")[0], 10),
    nodeModulesAbi: process.versions.modules,
  });
}

function hostRefusalReasons(targetName, host) {
  const target = RELEASE_TARGETS[targetName];
  const reasons = [];
  if (host.platform !== target.platform) reasons.push("host-platform");
  if (host.arch !== target.arch) reasons.push("host-arch");
  if (host.libc !== target.libc) reasons.push("host-libc");
  if (target.armVersion !== null && host.armVersion !== target.armVersion) {
    reasons.push("host-arm-version");
  }
  if (host.nodeMajor !== 20) reasons.push("host-node-major");
  if (host.nodeModulesAbi !== "115") reasons.push("host-node-abi");
  return reasons;
}

function runGit(source, args) {
  const result = spawnSync("git", args, {
    cwd: source,
    encoding: "utf8",
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || result.signal) {
    throw new Error(`git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

async function readStableFile(path, requireRootOwner = false) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("not a regular file");
  if (requireRootOwner && (before.uid !== 0n || (before.mode & 0o22n) !== 0n)) {
    throw new Error(
      "attestation must be root-owned and not group/world writable",
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    ) {
      throw new Error("file changed while being read");
    }
    return contents;
  } finally {
    await handle.close();
  }
}

function parseJson(contents, description) {
  try {
    const value = JSON.parse(contents.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("object required");
    }
    return value;
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function validateCache(source, expectedInventory) {
  if (!Array.isArray(expectedInventory) || expectedInventory.length === 0) {
    throw new Error("target cache inventory is absent");
  }
  const cacheRoot = join(source, ".yarn/cache");
  const children = await readdir(cacheRoot, { withFileTypes: true });
  const archiveNames = children
    .filter((child) => child.isFile() && child.name.endsWith(".zip"))
    .map((child) => child.name)
    .sort(bytewiseCompare);
  const expectedNames = expectedInventory
    .map((entry) => entry.path)
    .filter((path) => typeof path === "string")
    .map((path) => path.replace(/^\.yarn\/cache\//u, ""))
    .sort(bytewiseCompare);
  if (JSON.stringify(archiveNames) !== JSON.stringify(expectedNames)) {
    throw new Error("target cache file set differs from attestation");
  }
  for (const entry of expectedInventory) {
    if (!/^\.yarn\/cache\/[^/]+\.zip$/u.test(entry.path)) {
      throw new Error("target cache attestation contains an unsafe path");
    }
    const contents = await readStableFile(join(source, entry.path));
    if (contents.length !== entry.size || digest(contents) !== entry.sha256) {
      throw new Error(
        `target cache entry differs from attestation: ${entry.path}`,
      );
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  // These values intentionally come only from Node's immutable process identity.
  // Environment variables cannot impersonate a Linux ARM release host.
  const host = actualHostFacts();
  const earlyReasons = hostRefusalReasons(options.target, host);
  if (earlyReasons.length > 0) refuse(earlyReasons);

  let source;
  let packageJson;
  let attestation;
  let yarnLock;
  let checkout;
  try {
    source = await realpath(resolve(options.source));
    const sourceStat = await lstat(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error("source is not a regular directory");
    }
    const expectedOutputParent = join(source, "release-output");
    if (dirname(resolve(options.output)) !== expectedOutputParent) {
      throw new Error(
        "output must be a direct child of the release-output directory",
      );
    }
    const status = runGit(source, [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ]);
    const headCommit = runGit(source, ["rev-parse", "--verify", "HEAD"]);
    const tagKind = runGit(source, [
      "cat-file",
      "-t",
      `refs/tags/${options.tag}`,
    ]);
    const tagCommit = runGit(source, [
      "rev-parse",
      "--verify",
      `${options.tag}^{commit}`,
    ]);
    const commitEpochText = runGit(source, [
      "show",
      "-s",
      "--format=%ct",
      options.commit,
    ]);
    checkout = {
      clean: status === "",
      headCommit,
      tagKind,
      tagCommit,
      commitEpoch: Number.parseInt(commitEpochText, 10),
    };
    packageJson = parseJson(
      await readStableFile(join(source, "package.json")),
      "package.json",
    );
    yarnLock = await readStableFile(join(source, "yarn.lock"));
    attestation = parseJson(
      await readStableFile(options["builder-attestation"], true),
      "builder attestation",
    );
    await validateCache(source, attestation.cache?.inventory);
  } catch {
    refuse(["preflight-failed"]);
  }

  const decision = evaluateReleasePolicy({
    request: {
      version: options.version,
      commit: options.commit,
      target: options.target,
      tag: options.tag,
    },
    checkout,
    package: {
      version: packageJson.version,
      releaseTarget: packageJson.homeWorkerRelease?.target,
      packageManager: packageJson.packageManager,
    },
    host,
    builder: attestation.builder,
    environment: {
      tz: process.env.TZ,
      locale: process.env.LC_ALL,
      sourceDateEpoch: Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? "", 10),
    },
    cache: {
      ...attestation.cache,
      yarnLockSha256: digest(yarnLock),
    },
  });
  if (!decision.publishable) refuse(decision.reasons);

  // Candidate creation remains deliberately disabled in this safe local slice.
  // A later controlled-builder task may connect this gate to the archive writer.
  refuse(["candidate-emission-disabled"]);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
