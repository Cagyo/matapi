import { resolve, sep } from "node:path";

import { encodeBuilderPolicy, parseBuilderPolicy } from "./builder-policy.mjs";
import {
  encodeCandidateDescriptor,
  measureCandidateArchive,
} from "./candidate-descriptor.mjs";
import { computeCacheInventorySha256 } from "./release-policy.mjs";

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

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
    throw new Error("Source, work, and output roots must be separate");
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

function runStep(dependencies, phase, command, args, cwd, env) {
  return dependencies.run({ phase, command, args, cwd, env });
}

export async function runCandidateBuild(rawInput, dependencies) {
  let input = validateInput(rawInput);
  const resolved = await dependencies.resolveBuildRoots({
    sourceRoot: input.sourceRoot,
    workRoot: input.workRoot,
    outputRoot: input.outputRoot,
  });
  if (
    !separated(resolved.sourceRoot, resolved.workRoot) ||
    !separated(resolved.sourceRoot, resolved.outputRoot) ||
    !separated(resolved.workRoot, resolved.outputRoot)
  ) {
    throw new Error(
      "Canonical source, work, and output roots must be separate",
    );
  }
  input = {
    ...input,
    sourceRoot: resolved.sourceRoot,
    workRoot: resolved.workRoot,
    outputRoot: resolved.outputRoot,
  };
  const buildRoot = `${input.workRoot}/build`;
  const assemblyRoot = `${input.workRoot}/assembly`;
  const validationRoot = `${input.workRoot}/validation`;
  const buildState = `${input.workRoot}/state/build`;
  const assemblyState = `${input.workRoot}/state/assembly`;
  const validationState = `${input.workRoot}/state/validation`;
  const buildEnv = commandEnvironment(buildState, input.sourceDateEpoch, true);
  const assemblyEnv = commandEnvironment(
    assemblyState,
    input.sourceDateEpoch,
    true,
  );
  const validationEnv = commandEnvironment(
    validationState,
    input.sourceDateEpoch,
    false,
  );

  await dependencies.prepareBuildCheckout({
    sourceRoot: input.sourceRoot,
    buildRoot,
    commit: input.commit,
    tag: input.tag,
  });
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

  await dependencies.prepareAssembly({ buildRoot, assemblyRoot });
  await runStep(
    dependencies,
    "pin-yarn",
    "/usr/bin/corepack",
    ["yarn", "set", "version", "4.13.0", "--yarn-path"],
    assemblyRoot,
    assemblyEnv,
  );
  await runStep(
    dependencies,
    "focus-production-online",
    "/usr/bin/node",
    [
      ".yarn/releases/yarn-4.13.0.cjs",
      "workspaces",
      "focus",
      "-A",
      "--production",
    ],
    assemblyRoot,
    assemblyEnv,
  );
  await dependencies.removeProductionProjection({ assemblyRoot });
  await dependencies.sealReleaseConfig({ assemblyRoot });
  const before = await dependencies.inspectCache(assemblyRoot);
  if (
    !SHA256.test(before?.sha256) ||
    computeCacheInventorySha256(before.inventory) !== before.sha256
  ) {
    throw new Error("Invalid sealed cache inventory");
  }

  await dependencies.prepareValidationCopy({ assemblyRoot, validationRoot });
  await runStep(
    dependencies,
    "focus-production-offline",
    "/usr/bin/node",
    [
      ".yarn/releases/yarn-4.13.0.cjs",
      "workspaces",
      "focus",
      "-A",
      "--production",
    ],
    validationRoot,
    validationEnv,
  );
  const after = await dependencies.inspectCache(validationRoot);
  if (
    !SHA256.test(after?.sha256) ||
    computeCacheInventorySha256(after.inventory) !== after.sha256 ||
    after.sha256 !== before.sha256
  ) {
    throw new Error(
      "Production cache mutation detected during offline validation",
    );
  }

  const generated = await dependencies.createArchive({
    assemblyRoot,
    sourceDateEpoch: input.sourceDateEpoch,
    expectedCacheInventory: before.inventory,
  });
  const archive = measureCandidateArchive({
    archiveBytes: generated.bytes,
    inventory: generated.inventory,
    sourceDateEpoch: input.sourceDateEpoch,
  });
  const descriptorBytes = encodeCandidateDescriptor({
    version: input.version,
    commit: input.commit,
    sourceDateEpoch: input.sourceDateEpoch,
    builderPolicy: input.builderPolicy,
    cacheInventorySha256: before.sha256,
    archive,
  });
  const basename = `home-worker-${input.version}-${input.target}`;
  const published = await dependencies.publish({
    outputRoot: input.outputRoot,
    archiveName: `${basename}.tar.gz`,
    archiveBytes: generated.bytes,
    descriptorName: `${basename}.candidate.json`,
    descriptorBytes,
    rootGuard: resolved.rootGuard,
  });
  return Object.freeze({ archive, descriptorBytes, published });
}
