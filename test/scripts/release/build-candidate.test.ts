import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

  it.runIf(process.platform === "darwin")(
    "refuses a Linux ARM candidate from Darwin before source or output access",
    () => {
      const outputPath = join(tmpdir(), `must-not-exist-${process.pid}.tar.gz`);
      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "--version",
          "1.2.3",
          "--commit",
          "a".repeat(40),
          "--tag",
          "v1.2.3",
          "--target",
          "linux-arm64-glibc",
          "--source",
          "/path/that/does/not/exist",
          "--work-root",
          `${outputPath}.work`,
          "--output-root",
          `${outputPath}.output`,
          "--builder-policy",
          "/path/that/does/not/exist.json",
        ],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            RELEASE_HOST_PLATFORM: "linux",
            RELEASE_HOST_ARCH: "arm64",
            RELEASE_NODE_MAJOR: "20",
          },
        },
      );

      expect(result.status).toBe(75);
      expect(result.stderr).toContain("NONPUBLISHABLE");
      expect(result.stderr).toContain("host-platform");
      expect(result.stderr).toContain("host-node-major");
    },
  );

  it("refuses ARMv7 even when supplied ARMv7 host facts", () => {
    expect(
      hostRefusalReasons("linux-armv7-glibc", {
        platform: "linux",
        arch: "arm",
        armVersion: 7,
        libc: "glibc",
        libcVersion: "2.36",
        nodeMajor: 20,
        nodeModulesAbi: "115",
      }),
    ).toContain("target-disabled");
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
