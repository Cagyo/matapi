import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactLedgerIdentitySha256,
  type ArtifactIdentity,
  type TrustedArtifact,
} from "../../../src/system/domain/ota-contracts";
import type { TrustedStateCommit } from "../../../src/system/domain/ports/trusted-state.port";
import { DualSlotTrustedStateAdapter } from "../../../src/system/infrastructure/dual-slot-trusted-state.adapter";

const roots: string[] = [];
const ARTIFACT_SHA = "a".repeat(64);
const FIRST_METADATA_SHA = "b".repeat(64);
const TARGET_NAME = "linux-armv7-glibc";

function artifactIdentity(artifactSha256 = ARTIFACT_SHA): ArtifactIdentity {
  return {
    version: "1.4.2",
    commit: "0123456789abcdef0123456789abcdef01234567",
    targetName: TARGET_NAME,
    target: {
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcMinVersion: "2.28",
      nodeModulesAbi: "115",
    },
    url: "https://updates.example.test/home-worker/releases/home-worker-1.4.2.tar.gz",
    format: "tar.gz",
    size: 50 * 1024 * 1024,
    expandedSize: 200 * 1024 * 1024,
    maxPreparedSize: 300 * 1024 * 1024,
    maxPreparedFiles: 10_000,
    fileCount: 8_500,
    sha256: artifactSha256,
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(resolve(tmpdir(), "trusted-state-"));
  roots.push(root);
  return root;
}

function envelope(metadataVersion = 42, artifactSha256 = ARTIFACT_SHA) {
  const identity = artifactIdentity(artifactSha256);
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      metadataVersion,
      channel: "stable",
      version: identity.version,
      commit: identity.commit,
      publishedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-31T00:00:00.000Z",
      target: identity.target,
      artifact: {
        url: identity.url,
        format: identity.format,
        size: identity.size,
        expandedSize: identity.expandedSize,
        maxPreparedSize: identity.maxPreparedSize,
        maxPreparedFiles: identity.maxPreparedFiles,
        fileCount: identity.fileCount,
        sha256: identity.sha256,
      },
      runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
    }),
  );
  const outer = Buffer.from(
    JSON.stringify({
      payload: payload.toString("base64"),
      signatures: [
        {
          keyId: "c".repeat(64),
          signature: Buffer.alloc(64, 1).toString("base64"),
        },
      ],
    }),
  );
  return {
    bytes: outer.toString("base64"),
    etag: '"v1"',
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
  };
}

function state(
  generation: number,
  metadataVersion = 42,
  artifactSha256 = ARTIFACT_SHA,
): TrustedStateCommit {
  const cached = envelope(metadataVersion, artifactSha256);
  const identity = artifactIdentity(artifactSha256);
  return {
    schemaVersion: 1,
    generation,
    writtenAt: "2030-01-01T00:00:00.000Z",
    highestMetadata: {
      metadataVersion,
      payloadSha256: cached.payloadSha256,
    },
    envelope: { bytes: cached.bytes, etag: cached.etag },
    timeAnchor: {
      wallMs: 1_893_456_000_000,
      monotonicMs: 1_000,
      bootId: "boot-1",
      persistedAtMs: 1_893_456_000_000,
    },
    artifacts: [
      {
        channel: "stable",
        targetName: TARGET_NAME,
        version: identity.version,
        artifactIdentitySha256: artifactLedgerIdentitySha256(
          "stable",
          identity,
        ),
        artifactSha256,
        firstMetadataSha256: FIRST_METADATA_SHA,
      },
    ],
    lastNotification: {
      version: "1.4.2",
      artifactSha256,
    },
    failureDays: [{ day: "2030-01-01", codes: ["network-timeout"] }],
  };
}

function slot(root: string, name: "a" | "b"): string {
  return resolve(root, `trusted-state-${name}.json`);
}

function checksummed<T extends Record<string, unknown>>(value: T) {
  return {
    ...value,
    checksum: createHash("sha256")
      .update(JSON.stringify(value), "utf8")
      .digest("hex"),
  };
}

describe("DualSlotTrustedStateAdapter", () => {
  it("fails closed when both slots are missing", async () => {
    await expect(
      new DualSlotTrustedStateAdapter(directory()).load(),
    ).rejects.toThrow(/trust-state-lost/);
  });

  it("seeds a baseline pair and loads an exact Task 1 trusted-state document", async () => {
    const root = directory();
    const store = new DualSlotTrustedStateAdapter(root);

    await store.seed(state(1));

    expect((await store.load()).generation).toBe(1);
    expect(JSON.parse(readFileSync(slot(root, "a"), "utf8"))).toEqual(
      JSON.parse(readFileSync(slot(root, "b"), "utf8")),
    );
  });

  it("selects the highest checksum-valid generation after a torn write", async () => {
    const root = directory();
    const store = new DualSlotTrustedStateAdapter(root);
    await store.seed(state(1));
    await store.commit(state(7));
    await store.commit(state(8));

    writeFileSync(slot(root, "b"), "torn");

    expect((await store.load()).generation).toBe(7);
  });

  it("ignores a higher generation whose canonical checksum is corrupt", async () => {
    const root = directory();
    const store = new DualSlotTrustedStateAdapter(root);
    await store.seed(state(1));
    await store.commit(state(2));
    const higher = JSON.parse(readFileSync(slot(root, "a"), "utf8"));
    higher.checksum = "0".repeat(64);
    writeFileSync(slot(root, "a"), JSON.stringify(higher));

    expect((await store.load()).generation).toBe(1);
  });

  it("rejects an oversized slot without buffering it as trusted state", async () => {
    const root = directory();
    writeFileSync(slot(root, "a"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));

    await expect(new DualSlotTrustedStateAdapter(root).load()).rejects.toThrow(
      /trust-state-lost/,
    );
  });

  it("requires the highest metadata digest to match the cached outer-envelope payload", async () => {
    const root = directory();
    const store = new DualSlotTrustedStateAdapter(root);
    const invalid = state(1);
    invalid.highestMetadata.payloadSha256 = "d".repeat(64);

    await expect(store.seed(invalid)).rejects.toThrow(/payload/i);
  });

  it("requires the highest metadata version and current artifact to match the payload ledger", async () => {
    const root = directory();
    const store = new DualSlotTrustedStateAdapter(root);
    const wrongVersion = state(1);
    wrongVersion.highestMetadata.metadataVersion = 41;
    await expect(store.seed(wrongVersion)).rejects.toThrow(/metadataVersion/i);

    const missingArtifact = state(1);
    missingArtifact.artifacts = [];
    await expect(store.seed(missingArtifact)).rejects.toThrow(/ledger/i);

    const wrongFullIdentity = state(1);
    wrongFullIdentity.artifacts[0].artifactIdentitySha256 = "d".repeat(64);
    await expect(store.seed(wrongFullIdentity)).rejects.toThrow(
      /identity|ledger/i,
    );
  });

  it("fails closed on a checksum-valid legacy three-key ledger entry", async () => {
    const root = directory();
    const legacy = structuredClone(state(1)) as unknown as Record<
      string,
      unknown
    >;
    legacy.artifacts = [
      {
        version: "1.4.2",
        artifactSha256: ARTIFACT_SHA,
        firstMetadataSha256: FIRST_METADATA_SHA,
      },
    ];
    writeFileSync(slot(root, "a"), JSON.stringify(checksummed(legacy)));

    await expect(new DualSlotTrustedStateAdapter(root).load()).rejects.toThrow(
      /trust-state-lost/,
    );
  });

  it("enforces the 1,024-entry artifact ledger bound", async () => {
    const root = directory();
    const store = new DualSlotTrustedStateAdapter(root);
    const oversized = state(1);
    oversized.artifacts = Array.from({ length: 1_025 }, () => ({
      channel: "stable" as const,
      targetName: TARGET_NAME,
      version: "1.4.2",
      artifactIdentitySha256: artifactLedgerIdentitySha256(
        "stable",
        artifactIdentity(),
      ),
      artifactSha256: ARTIFACT_SHA,
      firstMetadataSha256: FIRST_METADATA_SHA,
    }));

    await expect(store.seed(oversized)).rejects.toThrow(/artifacts/i);
  });

  it("retains the previous generation when interrupted after syncing the temp file", async () => {
    const root = directory();
    const baseline = new DualSlotTrustedStateAdapter(root);
    await baseline.seed(state(1));
    const interrupted = new DualSlotTrustedStateAdapter(root, {
      afterTempFileSync: () => {
        throw new Error("simulated process kill");
      },
    });

    await expect(interrupted.commit(state(2))).rejects.toThrow(
      /simulated process kill/,
    );
    expect((await baseline.load()).generation).toBe(1);
  });

  it("retains the previous generation when the writer process is killed before rename", async () => {
    const root = directory();
    const baseline = new DualSlotTrustedStateAdapter(root);
    await baseline.seed(state(1));
    const inputPath = resolve(root, "next-state.json");
    writeFileSync(inputPath, JSON.stringify(state(2)));
    const script = [
      'const fs = require("node:fs")',
      'const { DualSlotTrustedStateAdapter } = require("./src/system/infrastructure/dual-slot-trusted-state.adapter")',
      "const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))",
      "new DualSlotTrustedStateAdapter(process.argv[1], { afterTempFileSync: () => process.kill(process.pid, 'SIGKILL') }).commit(state)",
    ].join(";");
    const child = spawn(
      process.execPath,
      ["-r", "ts-node/register/transpile-only", "-e", script, root, inputPath],
      { cwd: process.cwd(), stdio: "ignore" },
    );

    const [, signal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];

    expect(signal).toBe("SIGKILL");
    expect((await baseline.load()).generation).toBe(1);
    await baseline.commit(state(3));
    expect((await baseline.load()).generation).toBe(3);
  });

  it("refuses non-advancing generations and maintenance reseeding", async () => {
    const root = directory();
    const store = new DualSlotTrustedStateAdapter(root);
    await store.seed(state(1));

    await expect(store.commit(state(1))).rejects.toThrow(/generation/i);
    await expect(store.seed(state(2))).rejects.toThrow(/seed/i);
  });

  it("serializes concurrent commits across adapters sharing a state directory", async () => {
    const root = directory();
    let releaseGenerationTwo!: () => void;
    const generationTwoBlocked = new Promise<void>((resolveBlocked) => {
      releaseGenerationTwo = resolveBlocked;
    });
    let generationTwoReached!: () => void;
    const reachedGenerationTwo = new Promise<void>((resolveReached) => {
      generationTwoReached = resolveReached;
    });
    const olderWriter = new DualSlotTrustedStateAdapter(root, {
      afterTempFileSync: async (path) => {
        const generation = JSON.parse(readFileSync(path, "utf8")).generation;
        if (generation === 2) {
          generationTwoReached();
          await generationTwoBlocked;
        }
      },
    });
    const newerWriter = new DualSlotTrustedStateAdapter(root);
    await olderWriter.seed(state(1));

    const generationTwo = olderWriter.commit(state(2));
    await reachedGenerationTwo;
    const generationThree = newerWriter.commit(state(3));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    releaseGenerationTwo();
    await Promise.all([generationTwo, generationThree]);

    expect((await newerWriter.load()).generation).toBe(3);
  });

  it("preserves metadata, ledger, and trusted-time anti-rollback floors on commit", async () => {
    const root = directory();
    const store = new DualSlotTrustedStateAdapter(root);
    const baseline = state(1);
    baseline.artifacts.push({
      channel: "stable",
      targetName: TARGET_NAME,
      version: "1.0.0",
      artifactIdentitySha256: "d".repeat(64),
      artifactSha256: "e".repeat(64),
      firstMetadataSha256: "f".repeat(64),
    });
    await store.seed(baseline);

    await expect(store.commit(state(2, 41))).rejects.toThrow(/metadata/i);
    await expect(store.commit(state(2, 42, "d".repeat(64)))).rejects.toThrow(
      /metadata|equivocation/i,
    );

    const removedHistory = state(2);
    await expect(store.commit(removedHistory)).rejects.toThrow(/ledger/i);

    const historyMutations: ((entry: TrustedArtifact) => void)[] = [
      (entry) => {
        entry.channel = "candidate" as never;
      },
      (entry) => {
        entry.targetName = "linux-arm64-glibc";
      },
      (entry) => {
        entry.version = "1.0.1";
      },
      (entry) => {
        entry.artifactIdentitySha256 = "c".repeat(64);
      },
      (entry) => {
        entry.artifactSha256 = "0".repeat(64);
      },
      (entry) => {
        entry.firstMetadataSha256 = "0".repeat(64);
      },
    ];
    for (const mutateHistory of historyMutations) {
      const mutatedHistory = state(2);
      const history = structuredClone(baseline.artifacts[1]);
      mutateHistory(history);
      mutatedHistory.artifacts.push(history);
      await expect(store.commit(mutatedHistory)).rejects.toThrow(
        /ledger|channel/i,
      );
    }

    const regressedTime = state(2);
    regressedTime.artifacts.push(baseline.artifacts[1]);
    regressedTime.timeAnchor.wallMs -= 1;
    regressedTime.timeAnchor.persistedAtMs -= 1;
    await expect(store.commit(regressedTime)).rejects.toThrow(/time/i);
  });

  it("ignores a higher checksum-valid slot that regresses a prior metadata floor", async () => {
    const root = directory();
    const store = new DualSlotTrustedStateAdapter(root);
    await store.seed(state(1));
    writeFileSync(slot(root, "a"), JSON.stringify(checksummed(state(2, 41))));

    expect((await store.load()).generation).toBe(1);
  });

  it("rejects same-boot monotonic and affine trusted-time regression", async () => {
    const root = directory();
    const store = new DualSlotTrustedStateAdapter(root);
    await store.seed(state(1));

    const monotonicRegression = state(2);
    monotonicRegression.timeAnchor.monotonicMs -= 1;
    await expect(store.commit(monotonicRegression)).rejects.toThrow(
      /monotonic|time/i,
    );

    const affineRegression = state(2);
    affineRegression.timeAnchor.monotonicMs += 1;
    await expect(store.commit(affineRegression)).rejects.toThrow(
      /affine|time/i,
    );
  });

  it.each(["EIO", "EMFILE", "EACCES"])(
    "propagates unexpected slot read error %s",
    async (code) => {
      const root = directory();
      const baseline = new DualSlotTrustedStateAdapter(root);
      await baseline.seed(state(1));
      const failure = Object.assign(new Error(`injected ${code}`), { code });
      const failing = new DualSlotTrustedStateAdapter(root, {
        beforeSlotRead: () => {
          throw failure;
        },
      });

      await expect(failing.load()).rejects.toBe(failure);
    },
  );

  it("refuses to write through a symlink state directory", async () => {
    const parent = directory();
    const target = resolve(parent, "target");
    const linked = resolve(parent, "linked");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, linked, "dir");

    await expect(
      new DualSlotTrustedStateAdapter(linked).seed(state(1)),
    ).rejects.toThrow(/directory/i);
    expect(statSync(target).isDirectory()).toBe(true);
    expect(() => statSync(resolve(target, "trusted-state-a.json"))).toThrow();
  });

  it("refuses to write into a permissive pre-existing state directory", async () => {
    const root = directory();
    chmodSync(root, 0o755);

    await expect(
      new DualSlotTrustedStateAdapter(root).seed(state(1)),
    ).rejects.toThrow(/0700|permission|directory/i);
    expect(() => statSync(slot(root, "a"))).toThrow();
  });

  it("revalidates directory mode after temp sync and before rename", async () => {
    const root = directory();
    const baseline = new DualSlotTrustedStateAdapter(root);
    await baseline.seed(state(1));
    const writer = new DualSlotTrustedStateAdapter(root, {
      afterTempFileSync: () => chmodSync(root, 0o755),
    });

    await expect(writer.commit(state(2))).rejects.toThrow(
      /0700|permission|directory/i,
    );
    chmodSync(root, 0o700);
    expect((await baseline.load()).generation).toBe(1);
  });

  it("creates the state directory and durable slots with owner-only permissions", async () => {
    const parent = directory();
    const root = resolve(parent, "nested/state");
    const store = new DualSlotTrustedStateAdapter(root);
    await store.seed(state(1));

    expect(readFileSync(slot(root, "a"))).not.toHaveLength(0);
    expect(statSync(slot(root, "a")).mode & 0o777).toBe(0o600);
    expect(statSync(slot(root, "b")).mode & 0o777).toBe(0o600);
  });
});
