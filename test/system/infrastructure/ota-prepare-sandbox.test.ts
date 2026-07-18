import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeOtaArchiveFixtures } from "../../fixtures/ota/archives/archive-fixtures";
import {
  inspectCacheInventory,
  prepareDependencies,
  type PreparationRunner,
} from "../../../installer/ota-prepare.mjs";

const OPERATION_ID = "AbCdEfGhIjKlMnOpQrStUw";
const ARTIFACT_SHA256 = "a".repeat(64);
const METADATA_SHA256 = "b".repeat(64);
const roots: string[] = [];

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "ota-prepare-")));
  roots.push(root);
  const releasesRoot = join(root, "releases");
  const runtimeRoot = join(root, "run", "prepare");
  const candidateName = `1.4.2-${ARTIFACT_SHA256}`;
  const candidate = join(releasesRoot, candidateName);
  const operationRoot = join(runtimeRoot, OPERATION_ID);
  const cacheFixtures = join(root, "cache-fixtures");
  await mkdir(join(candidate, ".yarn", "releases"), { recursive: true });
  await mkdir(operationRoot, { recursive: true });
  await mkdir(join(operationRoot, "tmp"));
  await writeOtaArchiveFixtures(cacheFixtures);
  await mkdir(join(candidate, ".yarn", "cache"));
  await writeFile(
    join(candidate, ".yarn", "cache", "fixture.zip"),
    await readFile(
      join(cacheFixtures, "cache-cases", "valid.zip", "valid.zip"),
    ),
  );
  await writeFile(
    join(candidate, "package.json"),
    JSON.stringify({ packageManager: "yarn@4.13.0" }),
  );
  await writeFile(join(candidate, "yarn.lock"), "__metadata:\n  version: 8\n");
  await writeFile(
    join(candidate, ".yarnrc.yml"),
    [
      "nodeLinker: node-modules",
      "enableGlobalCache: false",
      "enableNetwork: false",
      "enableImmutableInstalls: true",
      "enableImmutableCache: true",
      "cacheFolder: .yarn/cache",
      "yarnPath: .yarn/releases/yarn-4.13.0.cjs",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(candidate, ".yarn", "releases", "yarn-4.13.0.cjs"),
    "// pinned yarn\n",
  );
  await writeFile(
    join(candidate, "artifact-state.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifact: { sha256: ARTIFACT_SHA256 },
      metadata: { payloadSha256: METADATA_SHA256 },
    }),
  );
  await symlink(candidate, join(operationRoot, "candidate"));

  const inventory = await inspectCacheInventory(
    join(candidate, ".yarn", "cache"),
  );
  await writeFile(
    join(runtimeRoot, `${OPERATION_ID}.json`),
    JSON.stringify({
      schemaVersion: 1,
      operationId: OPERATION_ID,
      candidate: candidateName,
      artifactSha256: ARTIFACT_SHA256,
      metadataSha256: METADATA_SHA256,
      inventorySha256: inventory.sha256,
    }),
  );
  return { root, runtimeRoot, releasesRoot, candidate };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ota-prepare dependency sandbox contract", () => {
  it("runs the bundled Yarn with only the fixed environment and leaves signed inputs unchanged", async () => {
    const setup = await fixture();
    const protectedPaths = [
      "package.json",
      "yarn.lock",
      ".yarnrc.yml",
      ".yarn/releases/yarn-4.13.0.cjs",
      "artifact-state.json",
    ];
    const before = await Promise.all(
      protectedPaths.map(async (path) =>
        digest(await readFile(join(setup.candidate, path))),
      ),
    );
    const runner: PreparationRunner = async ({ command, args, cwd, env }) => {
      expect(command).toBe("/usr/bin/node");
      expect(args).toEqual([
        ".yarn/releases/yarn-4.13.0.cjs",
        "workspaces",
        "focus",
        "-A",
        "--production",
      ]);
      expect(cwd).toBe(setup.candidate);
      expect(env).toMatchObject({
        HOME: join(setup.runtimeRoot, OPERATION_ID, "tmp", "home"),
        TMPDIR: join(setup.runtimeRoot, OPERATION_ID, "tmp"),
        NODE_OPTIONS: "--max-old-space-size=512",
        npm_config_jobs: "1",
        JOBS: "1",
        YARN_ENABLE_NETWORK: "false",
        YARN_ENABLE_IMMUTABLE_CACHE: "true",
      });
      expect(Object.keys(env).sort()).toEqual(
        [
          "HOME",
          "JOBS",
          "NODE_ENV",
          "NODE_OPTIONS",
          "PATH",
          "TEMP",
          "TMP",
          "TMPDIR",
          "XDG_CACHE_HOME",
          "XDG_CONFIG_HOME",
          "YARN_CACHE_FOLDER",
          "YARN_ENABLE_GLOBAL_CACHE",
          "YARN_ENABLE_IMMUTABLE_CACHE",
          "YARN_ENABLE_IMMUTABLE_INSTALLS",
          "YARN_ENABLE_NETWORK",
          "YARN_IGNORE_PATH",
          "npm_config_cache",
          "npm_config_jobs",
        ].sort(),
      );
      await mkdir(join(cwd, "node_modules"));
    };

    await expect(
      prepareDependencies(OPERATION_ID, runner, {
        runtimeRoot: setup.runtimeRoot,
        releasesRoot: setup.releasesRoot,
        enforceRootOwnership: false,
      }),
    ).resolves.toBeUndefined();

    const after = await Promise.all(
      protectedPaths.map(async (path) =>
        digest(await readFile(join(setup.candidate, path))),
      ),
    );
    expect(after).toEqual(before);
  });

  it("rejects cache mutation performed by dependency lifecycle code", async () => {
    const setup = await fixture();
    const runner: PreparationRunner = async ({ cwd }) => {
      await writeFile(join(cwd, ".yarn", "cache", "fixture.zip"), "mutated");
    };

    await expect(
      prepareDependencies(OPERATION_ID, runner, {
        runtimeRoot: setup.runtimeRoot,
        releasesRoot: setup.releasesRoot,
        enforceRootOwnership: false,
      }),
    ).rejects.toMatchObject({ code: "cache-mutation" });
  });

  it.each([
    "package.json",
    "yarn.lock",
    ".yarnrc.yml",
    ".yarn/releases/yarn-4.13.0.cjs",
    "artifact-state.json",
  ])("rejects lifecycle mutation of signed input %s", async (path) => {
    const setup = await fixture();
    const runner: PreparationRunner = async ({ cwd }) => {
      await writeFile(join(cwd, path), "mutated");
    };

    await expect(
      prepareDependencies(OPERATION_ID, runner, {
        runtimeRoot: setup.runtimeRoot,
        releasesRoot: setup.releasesRoot,
        enforceRootOwnership: false,
      }),
    ).rejects.toMatchObject({ code: "cache-mutation" });
  });

  it.each([
    "../escape",
    "short",
    "AbCdEfGhIjKlMnOpQrStU!",
    "AAAAAAAAAAAAAAAAAAAAAB",
  ])(
    "rejects hostile or non-canonical operation ID %s",
    async (operationId) => {
      await expect(prepareDependencies(operationId)).rejects.toMatchObject({
        code: "dependency-sandbox",
      });
    },
  );
});
