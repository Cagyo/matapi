import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { hostRefusalReasons } from "../../../scripts/release/build-candidate.mjs";
import {
  CandidateBuildFailure,
  encodeCandidateBuildFailure,
} from "../../../scripts/release/candidate-build-failure.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliPath = join(repositoryRoot, "scripts/release/build-candidate.mjs");

describe("release candidate CLI", () => {
  it("emits one canonical secret-free builder failure record", () => {
    const failure = new CandidateBuildFailure(
      "resolve-build-roots",
      "work-root-exists",
      { cause: new Error("SECRET /srv/private/source") },
    );

    const encoded = encodeCandidateBuildFailure(failure).toString("utf8");

    expect(encoded).toBe(
      '{"schemaVersion":1,"kind":"home-worker-candidate-build-failure","stage":"resolve-build-roots","code":"work-root-exists"}\n',
    );
    expect(encoded).not.toContain("SECRET");
    expect(encoded).not.toContain("/srv/private/source");
  });

  it("downgrades a forged failure classification to the closed fallback", () => {
    const forged = Object.assign(
      Object.create(CandidateBuildFailure.prototype) as CandidateBuildFailure,
      { stage: "SECRET-/srv/private", code: "attacker-controlled" },
    );

    expect(encodeCandidateBuildFailure(forged).toString("utf8")).toBe(
      '{"schemaVersion":1,"kind":"home-worker-candidate-build-failure","stage":"candidate-build","code":"unclassified-failure"}\n',
    );
  });

  it("allows either declared Pi target from a non-Pi source builder", () => {
    const darwinSourceBuilder = {
      platform: "darwin",
      arch: "arm64",
      armVersion: null,
      libc: "unknown",
      libcVersion: null,
      nodeMajor: 24,
      nodeModulesAbi: "137",
    };

    expect(
      hostRefusalReasons("linux-arm64-glibc", darwinSourceBuilder),
    ).toEqual([]);
    expect(
      hostRefusalReasons("linux-armv7-glibc", darwinSourceBuilder),
    ).toEqual([]);
  });

  it("has no shell tar path or host identity environment override", async () => {
    const candidateSources = await Promise.all(
      [
        cliPath,
        join(repositoryRoot, "scripts/release/candidate-orchestrator.mjs"),
        join(repositoryRoot, "scripts/release/node-candidate-dependencies.mjs"),
      ].map((path) => readFile(path, "utf8")),
    );
    const source = candidateSources.join("\n");
    expect(source).not.toMatch(
      /(?:exec|spawn)(?:File|Sync)?\([^\n]*['"]tar['"]/u,
    );
    expect(source).not.toMatch(/\b(?:ssh|scp|sftp)\b/iu);
    expect(source.match(/https?:\/\/[^"'\s]+/gu)).toEqual([
      "https://registry.npmjs.org",
    ]);
    expect(source).toContain("constants.O_DIRECTORY");
    expect(source).toContain("/proc/self/fd/");
    expect(source).not.toContain("RELEASE_HOST_PLATFORM");
    expect(source).not.toContain("RELEASE_HOST_ARCH");
    expect(source).not.toContain("RELEASE_NODE_MAJOR");
    expect(source).not.toContain("process.exit(EXIT_BUILD_FAILED)");
  });

  it("registers the candidate command and ignores only its output directory", async () => {
    const packageJson = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    );
    const gitignore = await readFile(
      join(repositoryRoot, ".gitignore"),
      "utf8",
    );

    expect(packageJson.scripts["release:candidate"]).toBe(
      "node scripts/release/build-candidate.mjs",
    );
    expect(packageJson.homeWorkerRelease).toEqual({
      target: "linux-arm64-glibc",
    });
    expect(gitignore.split(/\r?\n/u)).toContain("/release-output/");
  });
});
