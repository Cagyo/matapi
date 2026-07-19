import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cliPath = join(repositoryRoot, "scripts/release/build-candidate.mjs");

describe("release candidate CLI", () => {
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
          "--output",
          outputPath,
          "--builder-attestation",
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

  it("has no shell tar path or host identity environment override", async () => {
    const source = await readFile(cliPath, "utf8");
    expect(source).not.toMatch(
      /(?:exec|spawn)(?:File|Sync)?\([^\n]*['"]tar['"]/u,
    );
    expect(source).not.toContain("RELEASE_HOST_PLATFORM");
    expect(source).not.toContain("RELEASE_HOST_ARCH");
    expect(source).not.toContain("RELEASE_NODE_MAJOR");
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
    expect(gitignore.split(/\r?\n/u)).toContain("/release-output/");
  });
});
