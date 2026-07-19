import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createNodeCandidateDependencies,
  prepareIsolatedCommandEnvironment,
  publishCandidatePair,
  validateClonedTag,
} from "../../../scripts/release/node-candidate-dependencies.mjs";

const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

function git(cwd: string, args: string[]) {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
}

async function write(root: string, path: string, contents = `${path}\n`) {
  const destination = join(root, path);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, contents);
}

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), "candidate-build-"));
  for (const path of [
    "package.json",
    "yarn.lock",
    "config/defaults.yml",
    "dist/main.js",
    "dist/feature.js",
    "migrations/0001.sql",
    "migrations/meta/_journal.json",
    "scripts/rollback.sh",
    "scripts/system-update.sh",
    "scripts/update.sh",
  ]) {
    await write(root, path);
  }
  await write(root, "src/private.ts");
  await write(root, "test/dev-only.ts");
  await write(root, ".env", "SECRET=nope\n");
  await write(root, "artifact-state.json", "{}\n");
  await write(root, ".yarnrc.yml", "enableNetwork: true\n");
  return root;
}

describe("node candidate dependencies", () => {
  it("requires the cloned annotated tag to resolve exactly to the commit", () => {
    expect(() => {
      validateClonedTag({
        tagKind: "tag",
        tagCommit: "a".repeat(40),
        commit: "a".repeat(40),
      });
    }).not.toThrow();
    expect(() => {
      validateClonedTag({
        tagKind: "tag",
        tagCommit: "b".repeat(40),
        commit: "a".repeat(40),
      });
    }).toThrow(
      expect.objectContaining({
        stage: "prepare-build-checkout",
        code: "tag-commit-mismatch",
      }),
    );
    expect(() => {
      validateClonedTag({
        tagKind: "commit",
        tagCommit: "a".repeat(40),
        commit: "a".repeat(40),
      });
    }).toThrow(
      expect.objectContaining({
        stage: "prepare-build-checkout",
        code: "tag-not-annotated",
      }),
    );
  });

  it("copies the exact annotated tag from a detached source checkout", async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "candidate-detached-tag-")),
    );
    const sourceRoot = join(parent, "source");
    const buildRoot = join(parent, "work", "build");
    await mkdir(sourceRoot);
    git(sourceRoot, ["init"]);
    git(sourceRoot, ["config", "user.email", "test@example.invalid"]);
    git(sourceRoot, ["config", "user.name", "Candidate test"]);
    await writeFile(join(sourceRoot, "package.json"), "{}\n");
    git(sourceRoot, ["add", "package.json"]);
    git(sourceRoot, ["commit", "-m", "fixture"]);
    const commit = git(sourceRoot, ["rev-parse", "HEAD"]);
    git(sourceRoot, ["tag", "-a", "v1.2.3", "-m", "fixture tag"]);
    git(sourceRoot, ["checkout", "--detach", commit]);

    const dependencies = createNodeCandidateDependencies();
    await expect(
      dependencies.prepareBuildCheckout({
        sourceRoot,
        buildRoot,
        commit,
        tag: "v1.2.3",
      }),
    ).resolves.toBeUndefined();
    expect(git(buildRoot, ["cat-file", "-t", "refs/tags/v1.2.3"])).toBe("tag");
    expect(git(buildRoot, ["rev-parse", "v1.2.3^{commit}"])).toBe(commit);
  });

  it("rejects canonical output aliases into the immutable source", async () => {
    const parent = await mkdtemp(join(tmpdir(), "candidate-roots-"));
    const sourceRoot = join(parent, "source");
    const outputAlias = join(parent, "output-alias");
    await mkdir(join(sourceRoot, "output"), { recursive: true });
    await symlink(join(sourceRoot, "output"), outputAlias);
    const dependencies = createNodeCandidateDependencies();

    await expect(
      dependencies.resolveBuildRoots({
        sourceRoot,
        workRoot: join(parent, "work"),
        outputRoot: outputAlias,
      }),
    ).rejects.toThrow(/separate/i);
  });

  it("retains canonical root identities through paired publication", async () => {
    const parent = await mkdtemp(join(tmpdir(), "candidate-guarded-roots-"));
    const sourceRoot = join(parent, "source");
    const outputRoot = join(parent, "output");
    const workRoot = join(parent, "work");
    await mkdir(sourceRoot);
    await mkdir(outputRoot);
    const dependencies = createNodeCandidateDependencies();
    const resolved = await dependencies.resolveBuildRoots({
      sourceRoot,
      workRoot,
      outputRoot,
    });
    await mkdir(workRoot);

    await expect(
      publishCandidatePair({
        outputRoot: resolved.outputRoot,
        archiveName: "candidate.tar.gz",
        archiveBytes: Buffer.from("archive"),
        descriptorName: "candidate.candidate.json",
        descriptorBytes: Buffer.from("{}\n"),
        rootGuard: resolved.rootGuard,
      }),
    ).resolves.toMatchObject({
      archivePath: join(resolved.outputRoot, "candidate.tar.gz"),
      descriptorPath: join(resolved.outputRoot, "candidate.candidate.json"),
    });
  });

  it("creates only the task-scoped command state directories", async () => {
    const state = await mkdtemp(join(tmpdir(), "candidate-state-"));
    const env = {
      HOME: join(state, "home"),
      XDG_CACHE_HOME: join(state, "home/.cache"),
      XDG_CONFIG_HOME: join(state, "home/.config"),
      TMPDIR: join(state, "tmp"),
      TMP: join(state, "tmp"),
      TEMP: join(state, "tmp"),
      COREPACK_HOME: join(state, "corepack"),
    };

    await prepareIsolatedCommandEnvironment(env);

    for (const path of new Set(Object.values(env))) {
      await expect(stat(path)).resolves.toMatchObject({});
    }
  });

  it("refuses a subprocess outside the exact phase allowlist", async () => {
    const dependencies = createNodeCandidateDependencies();
    await expect(
      dependencies.run({
        phase: "test",
        command: "/bin/sh",
        args: ["-c", "exit 0"],
        cwd: "/",
        env: {},
      }),
    ).rejects.toThrow(/unexpected release command/i);
  });

  it("refuses a pre-existing work root before cloning", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "candidate-source-"));
    const workRoot = await mkdtemp(join(tmpdir(), "candidate-existing-work-"));
    const dependencies = createNodeCandidateDependencies();

    await expect(
      dependencies.prepareBuildCheckout({
        sourceRoot,
        buildRoot: join(workRoot, "build"),
        commit: "a".repeat(40),
        tag: "v1.2.3",
      }),
    ).rejects.toMatchObject({
      stage: "prepare-build-checkout",
      code: "work-root-exists",
    });
  });

  it("classifies a pre-existing candidate work root without exposing its path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "candidate-existing-layout-"));
    const sourceRoot = join(parent, "source");
    const workRoot = join(parent, "work");
    const outputRoot = join(parent, "output");
    await mkdir(sourceRoot);
    await mkdir(workRoot);
    await mkdir(outputRoot);
    const dependencies = createNodeCandidateDependencies();

    await expect(
      dependencies.resolveBuildRoots({ sourceRoot, workRoot, outputRoot }),
    ).rejects.toMatchObject({
      stage: "resolve-build-roots",
      code: "work-root-exists",
    });
  });

  it("assembles only immutable release inputs and omits updater-owned state", async () => {
    const buildRoot = await buildFixture();
    const root = await mkdtemp(join(tmpdir(), "candidate-work-"));
    const assemblyRoot = join(root, "assembly");
    const dependencies = createNodeCandidateDependencies();

    await dependencies.prepareAssembly({ buildRoot, assemblyRoot });

    await expect(
      readFile(join(assemblyRoot, "dist/main.js"), "utf8"),
    ).resolves.toBe("dist/main.js\n");
    await expect(
      readFile(join(assemblyRoot, "scripts/update.sh"), "utf8"),
    ).resolves.toBe("scripts/update.sh\n");
    for (const denied of [
      "src/private.ts",
      "test/dev-only.ts",
      ".env",
      "artifact-state.json",
      ".yarnrc.yml",
    ]) {
      await expect(access(join(assemblyRoot, denied))).rejects.toThrow();
    }
  });

  it("seals a pinned public-registry Yarn release policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "candidate-assembly-"));
    await mkdir(join(root, ".yarn/releases"), { recursive: true });
    await writeFile(join(root, ".yarn/releases/yarn-4.13.0.cjs"), "yarn\n");
    const dependencies = createNodeCandidateDependencies();

    await dependencies.sealReleaseConfig({ assemblyRoot: root });

    await expect(readFile(join(root, ".yarnrc.yml"), "utf8")).resolves.toBe(
      [
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
      ].join("\n"),
    );
  });

  it("publishes archive and descriptor as a durable no-overwrite pair", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "candidate-output-"));
    const archiveBytes = Buffer.from("archive");
    const descriptorBytes = Buffer.from('{"kind":"candidate"}\n');
    const input = {
      outputRoot,
      archiveName: "home-worker-1.2.3-linux-arm64-glibc.tar.gz",
      archiveBytes,
      descriptorName: "home-worker-1.2.3-linux-arm64-glibc.candidate.json",
      descriptorBytes,
    };

    const published = await publishCandidatePair(input);

    expect(await readFile(published.archivePath)).toEqual(archiveBytes);
    expect(await readFile(published.descriptorPath)).toEqual(descriptorBytes);
    expect(published.archiveSha256).toBe(sha256(archiveBytes));
    expect((await stat(published.archivePath)).mode & 0o777).toBe(0o644);
    await expect(publishCandidatePair(input)).rejects.toThrow(
      /already exists/i,
    );
    expect(await readFile(published.archivePath)).toEqual(archiveBytes);
    expect(await readFile(published.descriptorPath)).toEqual(descriptorBytes);
  });

  it("compensates both destinations when paired publication fails", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "candidate-output-fault-"));
    const archiveName = "candidate.tar.gz";
    const descriptorName = "candidate.candidate.json";

    await expect(
      publishCandidatePair({
        outputRoot,
        archiveName,
        archiveBytes: Buffer.from("archive"),
        descriptorName,
        descriptorBytes: Buffer.from("{}\n"),
        faultInjection: "after-archive-link",
      }),
    ).rejects.toThrow(/injected publication failure/i);
    await expect(access(join(outputRoot, archiveName))).rejects.toThrow();
    await expect(access(join(outputRoot, descriptorName))).rejects.toThrow();
  });
});
