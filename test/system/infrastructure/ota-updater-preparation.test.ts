import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  artifactLedgerIdentitySha256,
  type ArtifactMarker,
  type CheckedReleaseIdentity,
  type KnownGoodMarker,
  type OperationJournal,
  type OtaOperationRequest,
  type TrustedState,
} from "../../../src/system/domain/ota-contracts";
import type {
  ManifestPolicy,
  VerifiedEnvelope,
} from "../../../src/system/domain/signed-manifest";
import {
  OtaUpdaterService,
  type OtaUpdaterDependencies,
} from "../../../src/system/infrastructure/ota-updater.service";

const OPERATION_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const ACCEPTED_AT = "2030-01-15T00:00:00.000Z";
const ARTIFACT_SHA = "a".repeat(64);
const METADATA_SHA = "b".repeat(64);
const TREE_SHA = "c".repeat(64);
const ENVELOPE = Buffer.from("trusted-envelope");
const CANDIDATE = `1.4.2-${ARTIFACT_SHA}`;

const policy: ManifestPolicy = {
  feedUrl:
    "https://updates.example.test/home-worker/stable/linux-armv7-glibc/update-envelope.json",
  channel: "stable",
  target: {
    targetName: "linux-armv7-glibc",
    platform: "linux",
    arch: "arm",
    libc: "glibc",
    libcVersion: "2.36",
    nodeModulesAbi: "115",
  },
  runtime: { nodeMajor: 20, packageManager: "yarn@4.13.0" },
  limits: {
    maxArtifactBytes: 100 * 1024 * 1024,
    maxExpandedBytes: 512 * 1024 * 1024,
    maxPreparedBytes: 1024 * 1024 * 1024,
    maxPreparedFiles: 200_000,
    maxFiles: 20_000,
  },
};

function checkedRelease(metadataSha = METADATA_SHA): CheckedReleaseIdentity {
  return {
    artifact: {
      version: "1.4.2",
      commit: "0123456789abcdef0123456789abcdef01234567",
      targetName: "linux-armv7-glibc",
      target: {
        platform: "linux",
        arch: "arm",
        libc: "glibc",
        libcMinVersion: "2.28",
        nodeModulesAbi: "115",
      },
      url: "https://updates.example.test/home-worker/releases/1.4.2.tar.gz",
      format: "tar.gz",
      size: 1_024,
      expandedSize: 4_096,
      maxPreparedSize: 16_384,
      maxPreparedFiles: 200,
      fileCount: 12,
      sha256: ARTIFACT_SHA,
    },
    metadata: {
      metadataVersion: 42,
      channel: "stable",
      payloadSha256: metadataSha,
      publishedAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-31T00:00:00.000Z",
    },
  };
}

function request(expected = checkedRelease()): OtaOperationRequest {
  const payload = {
    schemaVersion: 1 as const,
    operationId: OPERATION_ID,
    kind: "update" as const,
    expected,
    acceptedAt: ACCEPTED_AT,
  };
  return {
    ...payload,
    requestSha256: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
  };
}

function verified(
  release = checkedRelease(),
  bytes = ENVELOPE,
): VerifiedEnvelope {
  return {
    outerBytes: Buffer.from(bytes),
    payloadBytes: Buffer.from("payload"),
    payloadSha256: release.metadata.payloadSha256,
    manifest: {} as VerifiedEnvelope["manifest"],
    matchingActiveKeyIds: ["d".repeat(64)],
    checkedRelease: release,
  };
}

function trustedState(release = checkedRelease()): TrustedState {
  return {
    schemaVersion: 1,
    generation: 8,
    writtenAt: ACCEPTED_AT,
    highestMetadata: {
      metadataVersion: release.metadata.metadataVersion,
      payloadSha256: release.metadata.payloadSha256,
    },
    envelope: { bytes: ENVELOPE.toString("base64"), etag: '"etag"' },
    timeAnchor: {
      wallMs: Date.parse(ACCEPTED_AT),
      monotonicMs: 10_000,
      bootId: "boot-a",
      persistedAtMs: Date.parse(ACCEPTED_AT),
    },
    artifacts: [
      {
        channel: "stable",
        targetName: release.artifact.targetName,
        version: release.artifact.version,
        artifactIdentitySha256: artifactLedgerIdentitySha256(
          "stable",
          release.artifact,
        ),
        artifactSha256: release.artifact.sha256,
        firstMetadataSha256: release.metadata.payloadSha256,
      },
    ],
    lastNotification: null,
    failureDays: [],
    checksum: "e".repeat(64),
  };
}

function preparingJournal(input = request()): OperationJournal {
  return {
    schemaVersion: 1,
    generation: 1,
    operationId: input.operationId,
    kind: input.kind,
    phase: "preparing",
    expected: input.expected,
    acceptedAt: input.acceptedAt,
    requestSha256: input.requestSha256,
    receiptGeneration: 1,
    priorCurrent: `1.4.1-${"f".repeat(64)}`,
    priorPrevious: null,
    candidate: CANDIDATE,
    preparedTreeSha256: null,
    diagnostics: { code: null, notes: [] },
    updatedAt: ACCEPTED_AT,
    checksum: "0".repeat(64),
  };
}

function artifactMarker(
  release = checkedRelease(),
  treeSha = TREE_SHA,
): ArtifactMarker {
  return {
    schemaVersion: 1,
    artifact: release.artifact,
    metadata: release.metadata,
    envelopeSha256: createHash("sha256").update(ENVELOPE).digest("hex"),
    preparedTreeSha256: treeSha,
    writtenAt: ACCEPTED_AT,
  };
}

function knownGood(): KnownGoodMarker {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    artifactSha256: ARTIFACT_SHA,
    metadataSha256: METADATA_SHA,
    preparedTreeSha256: TREE_SHA,
    activatedAt: ACCEPTED_AT,
  };
}

function dependencies(events: string[] = []): OtaUpdaterDependencies {
  const req = request();
  const journal = preparingJournal(req);
  return {
    policy,
    requests: {
      load: vi.fn(async () => req),
    },
    journal: {
      load: vi.fn(async () => null),
      start: vi.fn(async (input) => {
        events.push("journal:start");
        expect(input).toMatchObject({
          acceptedAt: req.acceptedAt,
          requestSha256: req.requestSha256,
          receiptGeneration: 1,
          candidate: CANDIDATE,
        });
        return journal;
      }),
      transition: vi.fn(async (_current, phase, update) => {
        events.push(`journal:${phase}`);
        return {
          ...journal,
          generation: 2,
          phase,
          preparedTreeSha256:
            update?.preparedTreeSha256 ?? journal.preparedTreeSha256,
        };
      }),
    },
    handshake: {
      write: vi.fn(async (_fd, receipt) => {
        events.push("handshake");
        expect(receipt).toEqual({
          schemaVersion: 1,
          operationId: OPERATION_ID,
          kind: "update",
          acceptedAt: ACCEPTED_AT,
          requestSha256: req.requestSha256,
          receiptGeneration: 1,
        });
      }),
    },
    trusted: {
      load: vi.fn(async () => {
        events.push("trusted:load");
        return trustedState();
      }),
    },
    clock: {
      capture: vi.fn(async () => ({
        synchronized: true,
        wallMs: Date.parse(ACCEPTED_AT),
        monotonicMs: 10_000,
        bootId: "boot-a",
      })),
    },
    verifier: {
      verify: vi.fn(() => {
        events.push("trusted:verify");
        return verified();
      }),
    },
    layout: {
      capturePointers: vi.fn(async () => ({
        current: `1.4.1-${"f".repeat(64)}`,
        previous: null,
      })),
      inspectCandidate: vi.fn(async () => ({ kind: "absent" as const })),
      removeIncomplete: vi.fn(async () => undefined),
      createTemporary: vi.fn(async () => ({
        directory: "/tmp/ota-private",
        artifactPath: "/tmp/ota-private/artifact.tar.gz",
      })),
      reserveCandidate: vi.fn(
        async () => `/opt/home-worker/releases/${CANDIDATE}`,
      ),
      writePreparationMarker: vi.fn(async () => {
        events.push("marker:preparation");
      }),
      createSharedLinks: vi.fn(async () => {
        events.push("links");
      }),
      writeFinalMarkers: vi.fn(async () => {
        events.push("markers:final");
      }),
      cleanupTemporary: vi.fn(async () => undefined),
    },
    storage: {
      preflight: vi.fn(async () => {
        events.push("storage:preflight");
      }),
      enforceDuringPreparation: async <T>(
        operation: (checkpoint: () => Promise<void>) => Promise<T>,
      ): Promise<T> =>
        operation(async (): Promise<void> => {
          events.push("storage:checkpoint");
        }),
    },
    transport: {
      fetchEnvelope: vi.fn(),
      downloadArtifact: vi.fn(async () => {
        events.push("download");
        return { size: 1_024, sha256: ARTIFACT_SHA };
      }),
    },
    archive: {
      extract: vi.fn(async () => {
        events.push("archive");
      }),
    },
    cache: {
      inspect: vi.fn(async () => {
        events.push("cache");
        return {
          archives: [],
          entryCount: 1,
          expandedBytes: 1,
          sha256: "1".repeat(64),
        };
      }),
    },
    preparation: {
      start: vi.fn(async () => {
        events.push("prepare");
      }),
    },
    tree: {
      measureAndDigest: vi.fn(async () => ({
        allocatedBytes: 1,
        entryCount: 1,
        sha256: TREE_SHA,
      })),
      flushDurably: vi.fn(async () => {
        events.push("tree:flush");
      }),
    },
  };
}

describe("OtaUpdaterService preparation", () => {
  it("binds the durable preparing journal before the receipt and prepares in checkpointed order", async () => {
    const events: string[] = [];
    const deps = dependencies(events);

    await new OtaUpdaterService(deps).run(OPERATION_ID, 3);

    expect(events.indexOf("journal:start")).toBeLessThan(
      events.indexOf("handshake"),
    );
    expect(events.indexOf("handshake")).toBeLessThan(
      events.indexOf("trusted:load"),
    );
    expect(events).toEqual([
      "journal:start",
      "handshake",
      "trusted:load",
      "trusted:verify",
      "storage:preflight",
      "storage:checkpoint",
      "download",
      "storage:checkpoint",
      "archive",
      "storage:checkpoint",
      "cache",
      "storage:checkpoint",
      "marker:preparation",
      "prepare",
      "storage:checkpoint",
      "links",
      "storage:checkpoint",
      "markers:final",
      "storage:checkpoint",
      "tree:flush",
      "storage:checkpoint",
      "journal:prepared",
    ]);
    expect(deps.transport.fetchEnvelope).not.toHaveBeenCalled();
    expect(deps.trusted).not.toHaveProperty("commit");
  });

  it.each(["stale", "corrupt"])(
    "leaves a %s journal untouched and requires maintenance",
    async (kind) => {
      const deps = dependencies();
      if (kind === "stale") {
        vi.mocked(deps.journal.load).mockResolvedValue(preparingJournal());
      } else {
        vi.mocked(deps.journal.load).mockRejectedValue(
          new Error("operation journal lost"),
        );
      }

      await expect(
        new OtaUpdaterService(deps).run(OPERATION_ID, 3),
      ).rejects.toMatchObject({ code: "maintenance-required" });
      expect(deps.journal.start).not.toHaveBeenCalled();
      expect(deps.handshake.write).not.toHaveBeenCalled();
      expect(deps.layout.inspectCandidate).not.toHaveBeenCalled();
    },
  );

  it("aborts when the exact cached trusted envelope no longer matches the request", async () => {
    const deps = dependencies();
    const other = checkedRelease("9".repeat(64));
    vi.mocked(deps.verifier.verify).mockReturnValue(verified(other));

    await expect(
      new OtaUpdaterService(deps).run(OPERATION_ID, 3),
    ).rejects.toMatchObject({ code: "metadata-equivocation" });
    expect(deps.transport.downloadArtifact).not.toHaveBeenCalled();
    expect(deps.transport.fetchEnvelope).not.toHaveBeenCalled();
  });

  it("reuses only a matching known-good candidate without extraction or Yarn", async () => {
    const deps = dependencies();
    vi.mocked(deps.layout.inspectCandidate).mockResolvedValue({
      kind: "known-good",
      path: `/opt/home-worker/releases/${CANDIDATE}`,
      artifactState: artifactMarker(),
      artifactEnvelope: ENVELOPE,
      knownGood: knownGood(),
    });

    await new OtaUpdaterService(deps).run(OPERATION_ID, 3);

    expect(deps.transport.downloadArtifact).not.toHaveBeenCalled();
    expect(deps.archive.extract).not.toHaveBeenCalled();
    expect(deps.preparation.start).not.toHaveBeenCalled();
    expect(deps.tree.flushDurably).not.toHaveBeenCalled();
    expect(deps.journal.transition).toHaveBeenCalledWith(
      expect.anything(),
      "prepared",
      expect.objectContaining({ preparedTreeSha256: TREE_SHA }),
    );
  });

  it("never removes or overwrites a mismatching known-good directory", async () => {
    const deps = dependencies();
    vi.mocked(deps.layout.inspectCandidate).mockResolvedValue({
      kind: "known-good",
      path: `/opt/home-worker/releases/${CANDIDATE}`,
      artifactState: artifactMarker(checkedRelease(), "8".repeat(64)),
      artifactEnvelope: ENVELOPE,
      knownGood: knownGood(),
    });

    await expect(
      new OtaUpdaterService(deps).run(OPERATION_ID, 3),
    ).rejects.toMatchObject({ code: "maintenance-required" });
    expect(deps.layout.removeIncomplete).not.toHaveBeenCalled();
    expect(deps.layout.reserveCandidate).not.toHaveBeenCalled();
  });

  it("removes only an incomplete candidate that is not a retained target", async () => {
    const deps = dependencies();
    vi.mocked(deps.layout.inspectCandidate).mockResolvedValue({
      kind: "incomplete",
      path: `/opt/home-worker/releases/${CANDIDATE}`,
      referenced: false,
    });

    await new OtaUpdaterService(deps).run(OPERATION_ID, 3);

    expect(deps.layout.removeIncomplete).toHaveBeenCalledWith(CANDIDATE);
    expect(deps.layout.reserveCandidate).toHaveBeenCalledWith(CANDIDATE);
  });

  it("does not journal prepared when the tree durability barrier fails", async () => {
    const deps = dependencies();
    vi.mocked(deps.tree.flushDurably).mockRejectedValue(
      new Error("injected fsync failure"),
    );

    await expect(
      new OtaUpdaterService(deps).run(OPERATION_ID, 3),
    ).rejects.toThrow("injected fsync failure");
    expect(deps.journal.transition).not.toHaveBeenCalled();
  });
});
