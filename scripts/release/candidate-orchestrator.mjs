import { resolve, sep } from "node:path";

import { encodeBuilderPolicy, parseBuilderPolicy } from "./builder-policy.mjs";
import {
  CandidateBuildFailure,
  classifyCandidateBuildFailure,
} from "./candidate-build-failure.mjs";
import {
  encodeCandidateDescriptor,
  measureCandidateArchive,
} from "./candidate-descriptor.mjs";

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const YARN_RUNTIME_PATH = ".yarn/releases/yarn-4.13.0.cjs";

function separated(left, right) {
  return (
    left !== right &&
    !left.startsWith(`${right}${sep}`) &&
    !right.startsWith(`${left}${sep}`)
  );
}

function validateInput(input) {
  const sourceRoot = resolve(input.sourceRoot);
  const workRoot = resolve(input.workRoot);
  const outputRoot = resolve(input.outputRoot);
  if (
    !VERSION.test(input.version) ||
    !COMMIT.test(input.commit) ||
    input.tag !== `v${input.version}` ||
    input.target !== "linux-arm64-glibc" ||
    !Number.isSafeInteger(input.sourceDateEpoch) ||
    input.sourceDateEpoch < 0
  ) {
    throw new Error("Invalid ARM64 candidate build input");
  }
  if (
    !separated(sourceRoot, workRoot) ||
    !separated(sourceRoot, outputRoot) ||
    !separated(workRoot, outputRoot)
  ) {
    throw new CandidateBuildFailure("resolve-build-roots", "root-overlap");
  }
  const builderPolicy = parseBuilderPolicy(
    encodeBuilderPolicy(input.builderPolicy),
  );
  return { ...input, sourceRoot, workRoot, outputRoot, builderPolicy };
}

function commandEnvironment(root, sourceDateEpoch, network) {
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    HOME: `${root}/home`,
    XDG_CACHE_HOME: `${root}/home/.cache`,
    XDG_CONFIG_HOME: `${root}/home/.config`,
    TMPDIR: `${root}/tmp`,
    TMP: `${root}/tmp`,
    TEMP: `${root}/tmp`,
    COREPACK_HOME: `${root}/corepack`,
    TZ: "UTC",
    LC_ALL: "C",
    SOURCE_DATE_EPOCH: String(sourceDateEpoch),
    NODE_ENV: "production",
    YARN_ENABLE_NETWORK: network ? "true" : "false",
    YARN_ENABLE_GLOBAL_CACHE: "false",
    YARN_ENABLE_IMMUTABLE_INSTALLS: "true",
    YARN_ENABLE_IMMUTABLE_CACHE: network ? "false" : "true",
  });
}

async function runAtStage(stage, operation, code = "operation-failed") {
  try {
    return await operation();
  } catch (error) {
    throw classifyCandidateBuildFailure(error, stage, code);
  }
}

function runStep(dependencies, phase, command, args, cwd, env) {
  return runAtStage(phase, () =>
    dependencies.run({ phase, command, args, cwd, env }),
  );
}

function requiredFileDigest(inventory, path) {
  const entry = inventory.find(
    (candidate) => candidate.path === path && candidate.type === "file",
  );
  if (!entry || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
    throw new Error(`Archive inventory is missing ${path}`);
  }
  return entry.sha256;
}

export async function runCandidateBuild(rawInput, dependencies) {
  let input;
  try {
    input = validateInput(rawInput);
  } catch (error) {
    throw classifyCandidateBuildFailure(
      error,
      "validate-input",
      "invalid-input",
    );
  }
  const resolved = await runAtStage("resolve-build-roots", () =>
    dependencies.resolveBuildRoots({
      sourceRoot: input.sourceRoot,
      workRoot: input.workRoot,
      outputRoot: input.outputRoot,
    }),
  );
  if (
    !separated(resolved.sourceRoot, resolved.workRoot) ||
    !separated(resolved.sourceRoot, resolved.outputRoot) ||
    !separated(resolved.workRoot, resolved.outputRoot)
  ) {
    throw new CandidateBuildFailure("resolve-build-roots", "root-overlap");
  }
  input = {
    ...input,
    sourceRoot: resolved.sourceRoot,
    workRoot: resolved.workRoot,
    outputRoot: resolved.outputRoot,
  };
  const buildRoot = `${input.workRoot}/build`;
  const assemblyRoot = `${input.workRoot}/assembly`;
  const buildState = `${input.workRoot}/state/build`;
  const assemblyState = `${input.workRoot}/state/assembly`;
  const buildEnv = commandEnvironment(buildState, input.sourceDateEpoch, true);
  const assemblyEnv = commandEnvironment(
    assemblyState,
    input.sourceDateEpoch,
    true,
  );

  await runAtStage("prepare-build-checkout", () =>
    dependencies.prepareBuildCheckout({
      sourceRoot: input.sourceRoot,
      buildRoot,
      commit: input.commit,
      tag: input.tag,
    }),
  );
  await runStep(
    dependencies,
    "install-development",
    "/usr/bin/corepack",
    ["yarn", "install", "--immutable"],
    buildRoot,
    buildEnv,
  );
  await runStep(
    dependencies,
    "test",
    "/usr/bin/corepack",
    ["yarn", "test"],
    buildRoot,
    buildEnv,
  );
  await runStep(
    dependencies,
    "build",
    "/usr/bin/corepack",
    ["yarn", "build"],
    buildRoot,
    buildEnv,
  );

  await runAtStage("prepare-assembly", () =>
    dependencies.prepareAssembly({ buildRoot, assemblyRoot }),
  );
  await runStep(
    dependencies,
    "pin-yarn",
    "/usr/bin/corepack",
    ["yarn", "set", "version", "4.13.0", "--yarn-path"],
    assemblyRoot,
    assemblyEnv,
  );
  await runAtStage("seal-release-config", () =>
    dependencies.sealReleaseConfig({ assemblyRoot }),
  );

  const generated = await runAtStage("create-archive", () =>
    dependencies.createArchive({
      assemblyRoot,
      sourceDateEpoch: input.sourceDateEpoch,
    }),
  );
  const archive = await runAtStage("measure-archive", () =>
    measureCandidateArchive({
      archiveBytes: generated.bytes,
      inventory: generated.inventory,
      sourceDateEpoch: input.sourceDateEpoch,
    }),
  );
  const descriptorBytes = await runAtStage("encode-descriptor", () =>
    encodeCandidateDescriptor({
      version: input.version,
      commit: input.commit,
      sourceDateEpoch: input.sourceDateEpoch,
      builderPolicy: input.builderPolicy,
      yarnLockSha256: requiredFileDigest(generated.inventory, "yarn.lock"),
      yarnRuntimeSha256: requiredFileDigest(
        generated.inventory,
        YARN_RUNTIME_PATH,
      ),
      archive,
    }),
  );
  const basename = `home-worker-${input.version}-${input.target}`;
  const published = await runAtStage("publish-local", () =>
    dependencies.publish({
      outputRoot: input.outputRoot,
      archiveName: `${basename}.tar.gz`,
      archiveBytes: generated.bytes,
      descriptorName: `${basename}.candidate.json`,
      descriptorBytes,
      rootGuard: resolved.rootGuard,
    }),
  );
  return Object.freeze({ archive, descriptorBytes, published });
}
