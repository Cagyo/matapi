import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  coordinatePreparation,
  fetchDependencies,
  validateLockLocators,
} from "../../../installer/ota-prepare.mjs";

const OPERATION_ID = "AbCdEfGhIjKlMnOpQrStUw";
const ARTIFACT_SHA256 = "a".repeat(64);
const METADATA_SHA256 = "b".repeat(64);
const COORDINATOR_CHALLENGE = "c".repeat(64);
const roots: string[] = [];

const yarnPolicy = [
  "nodeLinker: node-modules",
  "enableGlobalCache: false",
  "enableNetwork: false",
  "enableImmutableInstalls: true",
  "enableScripts: false",
  "checksumBehavior: throw",
  "npmRegistryServer: https://registry.npmjs.org",
  "npmAlwaysAuth: false",
  "yarnPath: .yarn/releases/yarn-4.13.0.cjs",
  "",
].join("\n");

const yarnLock = [
  "__metadata:",
  "  version: 8",
  "",
  '"home-worker@workspace:.":',
  "  version: 0.0.0-use.local",
  '  resolution: "home-worker@workspace:."',
  "",
  '"fixture@npm:^1.0.0":',
  "  version: 1.0.0",
  '  resolution: "fixture@npm:1.0.0"',
  "",
].join("\n");

async function fixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "ota-prepare-")));
  roots.push(root);
  const releasesRoot = join(root, "releases");
  const runtimeRoot = join(root, "run", "prepare");
  const candidateName = `1.4.2-${ARTIFACT_SHA256}`;
  const candidate = join(releasesRoot, candidateName);
  const operationRoot = join(runtimeRoot, OPERATION_ID);
  const liveRelease = join(releasesRoot, `1.4.1-${"d".repeat(64)}`);
  await mkdir(join(candidate, ".yarn", "releases"), { recursive: true });
  await mkdir(join(candidate, "dist"));
  await mkdir(join(candidate, "config"));
  await mkdir(join(candidate, "scripts"));
  await writeFile(join(candidate, "dist", "main.js"), "export {};\n");
  await writeFile(join(candidate, "config", "defaults.yml"), "timezone: UTC\n");
  await writeFile(join(candidate, "scripts", "update.sh"), "#!/bin/sh\n");
  await mkdir(liveRelease, { recursive: true });
  await writeFile(join(liveRelease, "live.txt"), "still-running\n");
  await mkdir(join(operationRoot, "tmp"), { recursive: true });
  await writeFile(
    join(candidate, "package.json"),
    JSON.stringify({ packageManager: "yarn@4.13.0" }),
  );
  await writeFile(join(candidate, "yarn.lock"), yarnLock);
  await writeFile(join(candidate, ".yarnrc.yml"), yarnPolicy);
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
  await writeFile(
    join(operationRoot, "tmp", "coordinator-challenge.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      operationId: OPERATION_ID,
      challenge: COORDINATOR_CHALLENGE,
    })}\n`,
  );
  const receiptPath = join(runtimeRoot, `${OPERATION_ID}.json`);
  await writeFile(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      operationId: OPERATION_ID,
      candidate: candidateName,
      artifactSha256: ARTIFACT_SHA256,
      metadataSha256: METADATA_SHA256,
    }),
  );
  const options = {
    runtimeRoot,
    releasesRoot,
    enforceRootOwnership: false,
  };
  return {
    root,
    runtimeRoot,
    releasesRoot,
    candidate,
    candidateName,
    liveRelease,
    receiptPath,
    options,
  };
}

async function successfulFetch(setup: Awaited<ReturnType<typeof fixture>>) {
  await fetchDependencies(
    OPERATION_ID,
    async ({ cwd }) => {
      await mkdir(join(cwd, "node_modules"));
      await writeFile(
        join(cwd, "node_modules", "fixture.js"),
        "module.exports=1\n",
      );
      await writeFile(join(cwd, ".yarn", "install-state.gz"), "state\n");
    },
    setup.options,
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("OTA dependency preparation", () => {
  it("installs production dependencies online with literal pinned Yarn and lifecycle scripts enabled", async () => {
    const setup = await fixture();
    let calls = 0;

    await fetchDependencies(
      OPERATION_ID,
      async ({ command, args, cwd, env }) => {
        calls += 1;
        expect(command).toBe("/usr/bin/node");
        expect(args).toEqual([
          ".yarn/releases/yarn-4.13.0.cjs",
          "workspaces",
          "focus",
          "--all",
          "--production",
        ]);
        expect(cwd).toBe(setup.candidate);
        expect(env).toMatchObject({
          HOME: join(setup.runtimeRoot, OPERATION_ID, "tmp", "home"),
          YARN_ENABLE_NETWORK: "true",
          YARN_ENABLE_SCRIPTS: "true",
          NODE_OPTIONS: "--max-old-space-size=256",
          YARN_NETWORK_CONCURRENCY: "1",
          YARN_TASK_POOL_CONCURRENCY: "1",
          YARN_ENABLE_IMMUTABLE_CACHE: "false",
          YARN_CHECKSUM_BEHAVIOR: "throw",
          YARN_NPM_REGISTRY_SERVER: "https://registry.npmjs.org",
          YARN_NPM_ALWAYS_AUTH: "false",
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
            "YARN_ENABLE_IMMUTABLE_INSTALLS",
            "YARN_ENABLE_IMMUTABLE_CACHE",
            "YARN_ENABLE_NETWORK",
            "YARN_ENABLE_SCRIPTS",
            "YARN_CHECKSUM_BEHAVIOR",
            "YARN_NPM_ALWAYS_AUTH",
            "YARN_NPM_REGISTRY_SERVER",
            "YARN_NETWORK_CONCURRENCY",
            "YARN_TASK_POOL_CONCURRENCY",
          ].sort(),
        );
        await mkdir(join(cwd, "node_modules"));
      },
      setup.options,
    );

    expect(calls).toBe(1);
    const prepared = JSON.parse(
      await readFile(
        join(setup.runtimeRoot, OPERATION_ID, "tmp", "build-sentinel.json"),
        "utf8",
      ),
    );
    expect(prepared).toMatchObject({
      schemaVersion: 1,
      operationId: OPERATION_ID,
      candidate: setup.candidateName,
      network: true,
      coordinatorChallenge: COORDINATOR_CHALLENGE,
      archiveInputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      preparedTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(prepared.preparedFiles).toBeGreaterThan(1);
  });

  it.each([
    "evil@git+ssh://git@example.test/repo.git",
    "evil@https://example.test/evil.tgz",
    "evil@npm:https://example.test/evil.tgz",
    "evil@file:../evil",
    "evil@portal:../evil",
    "evil@patch:evil@npm%3A1.0.0#./local.patch",
  ])("rejects unsupported lock locator %s", async (locator) => {
    expect(() => {
      validateLockLocators(
        `__metadata:\n  version: 8\n\n"evil@npm:*":\n  version: 1.0.0\n  resolution: "${locator}"\n`,
      );
    }).toThrow(expect.objectContaining({ code: "dependency-sandbox" }));
  });

  it.each([
    [
      "flow mapping",
      '__metadata:\n  version: 8\n\n"home-worker@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "home-worker@workspace:."\n"evil@npm:*": {version: 1.0.0, resolution: "evil@https://example.test/evil.tgz"}\n',
    ],
    [
      "spaced key",
      '__metadata:\n  version: 8\n\n"evil@npm:*":\n  version: 1.0.0\n  resolution : "evil@https://example.test/evil.tgz"\n',
    ],
    [
      "Unicode-escaped duplicate key",
      '__metadata:\n  version: 8\n\n"evil@npm:*":\n  version: 1.0.0\n  resolution: "evil@npm:1.0.0"\n  "resolutio\\u006e": "evil@https://example.test/evil.tgz"\n',
    ],
    [
      "bare-CR hidden record",
      '__metadata:\n  version: 8\n# x\r"evil@npm:*":\r  version: 1.0.0\r  resolution: "evil@https://example.test/evil.tgz"\n"ok@npm:*":\n  version: 1.0.0\n  resolution: "ok@npm:1.0.0"\n',
    ],
  ])("rejects a %s lockfile locator bypass", (_name, lockfile) => {
    expect(() => {
      validateLockLocators(lockfile);
    }).toThrow(expect.objectContaining({ code: "dependency-sandbox" }));
  });

  it("accepts Yarn's built-in compatibility patch locators", () => {
    expect(() => {
      validateLockLocators(
        '__metadata:\n  version: 8\n\n"fsevents@npm:2.3.3":\n  version: 2.3.3\n  resolution: "fsevents@patch:fsevents@npm%3A2.3.3#optional!builtin<compat/fsevents>::version=2.3.3&hash=df0bf1"\n',
      );
    }).not.toThrow();
  });

  it.each([
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepack",
    "postpack",
    "prepublish",
    "prepublishOnly",
  ])("rejects root manifest %s hooks before online fetch", async (hook) => {
    const setup = await fixture();
    await writeFile(
      join(setup.candidate, "package.json"),
      JSON.stringify({
        packageManager: "yarn@4.13.0",
        scripts: { [hook]: "node hostile.mjs" },
      }),
    );
    let calls = 0;

    await expect(
      fetchDependencies(
        OPERATION_ID,
        async () => {
          calls += 1;
        },
        setup.options,
      ),
    ).rejects.toMatchObject({ code: "dependency-sandbox" });
    expect(calls).toBe(0);
  });

  it("rejects bare-CR hidden Yarn policy before online fetch", async () => {
    const setup = await fixture();
    await writeFile(
      join(setup.candidate, ".yarnrc.yml"),
      `${yarnPolicy}# x\rnpmScopes:\r  evil:\r    npmRegistryServer: https://example.test\n`,
    );
    let calls = 0;

    await expect(
      fetchDependencies(
        OPERATION_ID,
        async () => {
          calls += 1;
        },
        setup.options,
      ),
    ).rejects.toMatchObject({ code: "dependency-sandbox" });
    expect(calls).toBe(0);
  });


  it("rejects fetch-time mutation of any archive input", async () => {
    const setup = await fixture();
    await expect(
      fetchDependencies(
        OPERATION_ID,
        async ({ cwd }) => {
          await mkdir(join(cwd, "node_modules"));
          await writeFile(join(cwd, "dist", "main.js"), "mutated\n");
        },
        setup.options,
      ),
    ).rejects.toMatchObject({ code: "dependency-install" });
  });

  it("requires a fresh receipt-bound preparation sentinel before coordinator success", async () => {
    const setup = await fixture();

    await expect(
      coordinatePreparation(OPERATION_ID, async () => undefined, setup.options),
    ).rejects.toMatchObject({ code: "dependency-install" });
    await expect(readdir(setup.candidate)).resolves.toEqual([]);
  });

  it("accepts coordinator success after the real online install completes", async () => {
    const setup = await fixture();

    await expect(
      coordinatePreparation(
        OPERATION_ID,
        async ({ phase }) => {
          expect(phase).toBe("fetch");
          await successfulFetch(setup);
        },
        setup.options,
      ),
    ).resolves.toBeUndefined();
    await expect(
      readFile(
        join(setup.runtimeRoot, OPERATION_ID, "tmp", "build-sentinel.json"),
        "utf8",
      ),
    ).resolves.toContain('"network":true');
  });

  it("coordinator removes a candidate after a failed install without touching the live release", async () => {
    const setup = await fixture();
    const phases: string[] = [];
    await expect(
      coordinatePreparation(
        OPERATION_ID,
        async ({ phase }) => {
          phases.push(phase);
          await mkdir(join(setup.candidate, "node_modules"), {
            recursive: true,
          });
          await writeFile(
            join(setup.candidate, "node_modules", "partial"),
            "partial install output\n",
          );
          throw new Error("install failed");
        },
        setup.options,
      ),
    ).rejects.toMatchObject({ code: "dependency-install" });
    expect(phases).toEqual(["fetch"]);
    await expect(readFile(join(setup.candidate, "package.json"))).rejects.toThrow();
    await expect(readdir(setup.candidate)).resolves.toEqual([]);
    await expect(
      readFile(join(setup.liveRelease, "live.txt"), "utf8"),
    ).resolves.toBe("still-running\n");
  });

  it.each([
    "../escape",
    "short",
    "AbCdEfGhIjKlMnOpQrStU!",
    "AAAAAAAAAAAAAAAAAAAAAB",
  ])(
    "rejects hostile or non-canonical operation ID %s",
    async (operationId) => {
      await expect(fetchDependencies(operationId)).rejects.toMatchObject({
        code: "dependency-sandbox",
      });
    },
  );
});
