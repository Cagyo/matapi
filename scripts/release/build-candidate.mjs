#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { constants, lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCandidateBuild } from "./candidate-orchestrator.mjs";
import { encodeCandidateBuildFailure } from "./candidate-build-failure.mjs";
import {
  createNodeCandidateDependencies,
  readRootOwnedBuilderPolicy,
} from "./node-candidate-dependencies.mjs";
import { RELEASE_TARGETS, bytewiseCompare } from "./release-policy.mjs";

const EXIT_USAGE = 64;
const EXIT_BUILD_FAILED = 70;
const EXIT_NONPUBLISHABLE = 75;
const REQUIRED_OPTIONS = Object.freeze([
  "version",
  "commit",
  "tag",
  "target",
  "source",
  "work-root",
  "output-root",
  "builder-policy",
]);

function usage(message) {
  if (message) process.stderr.write(`ERROR ${message}\n`);
  process.stderr.write(
    "Usage: build-candidate.mjs --version X.Y.Z --commit 40HEX --tag vX.Y.Z " +
      "--target linux-arm64-glibc --source ABSOLUTE_PATH --work-root ABSOLUTE_PATH " +
      "--output-root ABSOLUTE_PATH --builder-policy ABSOLUTE_PATH\n",
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
  for (const name of ["source", "work-root", "output-root", "builder-policy"]) {
    if (!options[name].startsWith("/")) usage(`${name} path must be absolute`);
  }
  return Object.freeze(options);
}

function actualHostFacts() {
  const report = process.report?.getReport();
  const libcVersion = report?.header?.glibcVersionRuntime;
  return Object.freeze({
    platform: process.platform,
    arch: process.arch,
    armVersion: Number(process.config.variables.arm_version) || null,
    libc: libcVersion ? "glibc" : "unknown",
    libcVersion: typeof libcVersion === "string" ? libcVersion : null,
    nodeMajor: Number.parseInt(process.versions.node.split(".")[0], 10),
    nodeModulesAbi: process.versions.modules,
  });
}

export function hostRefusalReasons(targetName, host) {
  const target = RELEASE_TARGETS[targetName];
  const reasons = [];
  if (targetName !== "linux-arm64-glibc") reasons.push("target-disabled");
  if (host.platform !== target?.platform) reasons.push("host-platform");
  if (host.arch !== target?.arch) reasons.push("host-arch");
  if (host.libc !== target?.libc) reasons.push("host-libc");
  if (target?.armVersion !== null && host.armVersion !== target?.armVersion) {
    reasons.push("host-arm-version");
  }
  if (host.nodeMajor !== 20) reasons.push("host-node-major");
  if (host.nodeModulesAbi !== "115") reasons.push("host-node-abi");
  return reasons;
}

function runGit(source, args) {
  const result = spawnSync("/usr/bin/git", args, {
    cwd: source,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || result.signal)
    throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
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

async function readStableFile(path) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("not a regular file");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(before, opened))
      throw new Error("file changed while opening");
    const contents = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(opened, after))
      throw new Error("file changed while reading");
    return contents;
  } finally {
    await handle.close();
  }
}

function parsePackage(bytes) {
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new Error("package.json is not valid JSON");
  }
}

function preflightReasons(options, checkout, packageJson, policy, host) {
  const reasons = [];
  if (!checkout.clean) reasons.push("checkout-dirty");
  if (checkout.headCommit !== options.commit) reasons.push("checkout-head");
  if (checkout.tagKind !== "tag") reasons.push("checkout-tag-kind");
  if (checkout.tagCommit !== options.commit)
    reasons.push("checkout-tag-commit");
  if (!Number.isSafeInteger(checkout.commitEpoch) || checkout.commitEpoch < 0) {
    reasons.push("checkout-commit-epoch");
  }
  if (packageJson.version !== options.version) reasons.push("package-version");
  if (packageJson.homeWorkerRelease?.target !== options.target)
    reasons.push("package-target");
  if (packageJson.packageManager !== "yarn@4.13.0")
    reasons.push("package-manager");
  if (policy.target.targetName !== options.target)
    reasons.push("builder-target");
  if (
    policy.target.platform !== host.platform ||
    policy.target.arch !== host.arch ||
    policy.target.libc !== host.libc ||
    policy.target.libcVersion !== host.libcVersion ||
    policy.target.nodeModulesAbi !== host.nodeModulesAbi ||
    policy.runtime.nodeMajor !== host.nodeMajor
  ) {
    reasons.push("builder-host-mismatch");
  }
  return reasons;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  // These facts come only from Node's process identity. Refusal occurs before
  // source, output, work, or builder-policy paths are accessed.
  const host = actualHostFacts();
  const earlyReasons = hostRefusalReasons(options.target, host);
  if (earlyReasons.length > 0) refuse(earlyReasons);

  let sourceRoot;
  let checkout;
  let packageJson;
  let builderPolicy;
  try {
    sourceRoot = await realpath(resolve(options.source));
    const source = await lstat(sourceRoot);
    if (!source.isDirectory() || source.isSymbolicLink())
      throw new Error("source is unsafe");
    const status = runGit(sourceRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ]);
    checkout = {
      clean: status === "",
      headCommit: runGit(sourceRoot, ["rev-parse", "--verify", "HEAD"]),
      tagKind: runGit(sourceRoot, [
        "cat-file",
        "-t",
        `refs/tags/${options.tag}`,
      ]),
      tagCommit: runGit(sourceRoot, [
        "rev-parse",
        "--verify",
        `${options.tag}^{commit}`,
      ]),
      commitEpoch: Number.parseInt(
        runGit(sourceRoot, ["show", "-s", "--format=%ct", options.commit]),
        10,
      ),
    };
    packageJson = parsePackage(
      await readStableFile(resolve(sourceRoot, "package.json")),
    );
    builderPolicy = await readRootOwnedBuilderPolicy(options["builder-policy"]);
  } catch {
    refuse(["preflight-failed"]);
  }

  const reasons = preflightReasons(
    options,
    checkout,
    packageJson,
    builderPolicy,
    host,
  );
  if (reasons.length > 0) refuse(reasons);

  try {
    const result = await runCandidateBuild(
      {
        version: options.version,
        commit: options.commit,
        tag: options.tag,
        target: options.target,
        sourceDateEpoch: checkout.commitEpoch,
        sourceRoot,
        workRoot: options["work-root"],
        outputRoot: options["output-root"],
        builderPolicy,
      },
      createNodeCandidateDependencies(),
    );
    process.stdout.write(`CANDIDATE ${JSON.stringify(result.published)}\n`);
  } catch (error) {
    process.stderr.write("BUILD_FAILED ");
    process.stderr.write(encodeCandidateBuildFailure(error));
    process.exitCode = EXIT_BUILD_FAILED;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await main();
