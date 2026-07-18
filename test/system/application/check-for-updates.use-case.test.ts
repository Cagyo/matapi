import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CheckForUpdatesUseCase } from "../../../src/system/application/check-for-updates.use-case";
import {
  artifactLedgerIdentitySha256,
  type ArtifactIdentity,
  type CheckedReleaseIdentity,
  type TrustedState,
} from "../../../src/system/domain/ota-contracts";
import type { OtaClockPort } from "../../../src/system/domain/ports/ota-clock.port";
import {
  ReleaseFeedTransportError,
  type ReleaseFeedTransportPort,
} from "../../../src/system/domain/ports/release-feed-transport.port";
import {
  SignedEnvelopeVerificationError,
  type SignedEnvelopeVerifierPort,
} from "../../../src/system/domain/ports/signed-envelope-verifier.port";
import type { TrustedStatePort } from "../../../src/system/domain/ports/trusted-state.port";
import type { InstalledReleasePort } from "../../../src/system/domain/ports/installed-release.port";
import type {
  ManifestPolicy,
  VerifiedEnvelope,
} from "../../../src/system/domain/signed-manifest";

const FEED_URL =
  "https://updates.example.test/home-worker/stable/update-envelope.json";
const CHECK_MS = Date.parse("2030-01-15T00:00:00.000Z");
const A = "a".repeat(64);
const B = "b".repeat(64);

const policy: ManifestPolicy = {
  feedUrl: FEED_URL,
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

function artifact(version = "1.4.2", sha256 = A): ArtifactIdentity {
  return {
    version,
    commit: "0123456789abcdef0123456789abcdef01234567",
    targetName: "linux-armv7-glibc",
    target: {
      platform: "linux",
      arch: "arm",
      libc: "glibc",
      libcMinVersion: "2.28",
      nodeModulesAbi: "115",
    },
    url: `https://updates.example.test/home-worker/releases/home-worker-${version}.tar.gz`,
    format: "tar.gz",
    size: 50 * 1024 * 1024,
    expandedSize: 200 * 1024 * 1024,
    maxPreparedSize: 300 * 1024 * 1024,
    maxPreparedFiles: 10_000,
    fileCount: 8_500,
    sha256,
  };
}

function checked(
  version = "1.4.2",
  metadataVersion = 42,
  artifactSha256 = A,
  payloadSha256 = B,
  expiresAt = "2030-01-31T00:00:00.000Z",
): CheckedReleaseIdentity {
  return {
    artifact: artifact(version, artifactSha256),
    metadata: {
      metadataVersion,
      channel: "stable",
      payloadSha256,
      publishedAt: "2030-01-01T00:00:00.000Z",
      expiresAt,
    },
  };
}

function verified(
  release: CheckedReleaseIdentity,
  bytes = Buffer.from("fresh"),
): VerifiedEnvelope {
  return {
    outerBytes: bytes,
    payloadBytes: Buffer.from("payload"),
    payloadSha256: release.metadata.payloadSha256,
    manifest: {} as VerifiedEnvelope["manifest"],
    matchingActiveKeyIds: ["c".repeat(64)],
    checkedRelease: release,
  };
}

function checksummed(value: Omit<TrustedState, "checksum">): TrustedState {
  return {
    ...value,
    checksum: createHash("sha256")
      .update(JSON.stringify(value), "utf8")
      .digest("hex"),
  };
}

function trusted(release = checked()): TrustedState {
  const cachedBytes = Buffer.from("cached").toString("base64");
  return checksummed({
    schemaVersion: 1,
    generation: 7,
    writtenAt: "2030-01-14T18:00:00.000Z",
    highestMetadata: {
      metadataVersion: release.metadata.metadataVersion,
      payloadSha256: release.metadata.payloadSha256,
    },
    envelope: { bytes: cachedBytes, etag: '"v42"' },
    timeAnchor: {
      wallMs: CHECK_MS - 60_000,
      monotonicMs: 1_000,
      bootId: "boot-1",
      persistedAtMs: CHECK_MS - 60_000,
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
  });
}

function harness(initial = trusted()) {
  let selected = structuredClone(initial);
  const order: string[] = [];
  const transport: ReleaseFeedTransportPort = {
    fetchEnvelope: vi.fn().mockResolvedValue({
      kind: "ok",
      bytes: Buffer.from("fresh"),
      etag: '"v43"',
    }),
    downloadArtifact: vi.fn(),
  };
  const state: TrustedStatePort = {
    load: vi.fn(async () => structuredClone(selected)),
    commit: vi.fn(async (next) => {
      order.push("commit");
      selected = checksummed(structuredClone(next));
      return structuredClone(selected);
    }),
  };
  const clock: OtaClockPort = {
    capture: vi.fn().mockResolvedValue({
      synchronized: true,
      wallMs: CHECK_MS,
      monotonicMs: 61_000,
      bootId: "boot-1",
    }),
  };
  const verifier: SignedEnvelopeVerifierPort = {
    verify: vi.fn((bytes) =>
      Buffer.from(bytes).toString("utf8") === "cached"
        ? verified(checked(), Buffer.from("cached"))
        : verified(checked("1.4.3", 43, B, "c".repeat(64)), Buffer.from(bytes)),
    ),
  };
  const installed: InstalledReleasePort = {
    loadCurrent: vi.fn(async () => {
      order.push("installed");
      return artifact("1.4.2", A);
    }),
  };
  const useCase = new CheckForUpdatesUseCase(
    transport,
    state,
    clock,
    verifier,
    installed,
    policy,
    {
      feedUrl: FEED_URL,
      maxEnvelopeBytes: 96 * 1024,
      timeouts: { connectMs: 1, firstByteMs: 1, idleMs: 1, totalMs: 4 },
    },
  );
  return {
    useCase,
    transport,
    state,
    clock,
    verifier,
    installed,
    order,
    current: () => selected,
  };
}

function verifyFreshAs(
  verifier: SignedEnvelopeVerifierPort,
  release: CheckedReleaseIdentity,
): void {
  vi.mocked(verifier.verify).mockImplementation((bytes) =>
    Buffer.from(bytes).toString("utf8") === "cached"
      ? verified(checked(), Buffer.from("cached"))
      : verified(release, Buffer.from(bytes)),
  );
}

describe("CheckForUpdatesUseCase", () => {
  it("re-verifies cached bytes on 304 and retries exactly once unconditionally when invalid", async () => {
    const h = harness();
    vi.mocked(h.transport.fetchEnvelope)
      .mockResolvedValueOnce({ kind: "not-modified" })
      .mockResolvedValueOnce({
        kind: "ok",
        bytes: Buffer.from("fresh"),
        etag: '"v43"',
      });
    vi.mocked(h.verifier.verify)
      .mockImplementationOnce(() => {
        throw new SignedEnvelopeVerificationError("signature-invalid");
      })
      .mockReturnValueOnce(verified(checked("1.4.3", 43, B, "c".repeat(64))));

    expect((await h.useCase.execute()).kind).toBe("available");
    expect(h.transport.fetchEnvelope).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ etag: null }),
    );
    expect(h.transport.fetchEnvelope).toHaveBeenCalledTimes(2);
    expect(h.order).toEqual(["commit", "installed"]);
  });

  it("uses one effective time for cached verification and fallback verification", async () => {
    const h = harness();
    vi.mocked(h.transport.fetchEnvelope)
      .mockResolvedValueOnce({ kind: "not-modified" })
      .mockResolvedValueOnce({
        kind: "ok",
        bytes: Buffer.from("fresh"),
        etag: '"v43"',
      });
    vi.mocked(h.verifier.verify)
      .mockImplementationOnce(() => {
        throw new SignedEnvelopeVerificationError("metadata-expired");
      })
      .mockReturnValueOnce(verified(checked("1.4.3", 43, B, "c".repeat(64))));

    await h.useCase.execute();

    expect(
      vi.mocked(h.verifier.verify).mock.calls.map((call) => call[2].getTime()),
    ).toEqual([CHECK_MS, CHECK_MS]);
    expect(h.clock.capture).toHaveBeenCalledTimes(1);
  });

  it("treats a second 304 after unconditional fallback as a typed transport failure", async () => {
    const h = harness();
    vi.mocked(h.transport.fetchEnvelope).mockResolvedValue({
      kind: "not-modified",
    });
    vi.mocked(h.verifier.verify).mockImplementation(() => {
      throw new SignedEnvelopeVerificationError("signature-invalid");
    });

    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "http-status" },
    });
    expect(h.state.commit).not.toHaveBeenCalled();
  });

  it("preserves the real transport protocol failure for a null-ETag fallback 304", async () => {
    const h = harness();
    vi.mocked(h.transport.fetchEnvelope)
      .mockResolvedValueOnce({ kind: "not-modified" })
      .mockRejectedValueOnce(new ReleaseFeedTransportError("http-status"));
    vi.mocked(h.verifier.verify).mockImplementation(() => {
      throw new SignedEnvelopeVerificationError("signature-invalid");
    });

    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "http-status" },
    });
    expect(h.transport.fetchEnvelope).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ etag: null }),
    );
    expect(h.state.commit).not.toHaveBeenCalled();
  });

  it("keeps expired-cache fallback network failure classified as metadata freeze", async () => {
    const h = harness();
    vi.mocked(h.transport.fetchEnvelope)
      .mockResolvedValueOnce({ kind: "not-modified" })
      .mockRejectedValueOnce(
        new ReleaseFeedTransportError("network-unavailable"),
      );
    vi.mocked(h.verifier.verify).mockImplementation(() => {
      throw new SignedEnvelopeVerificationError("metadata-expired");
    });

    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "metadata-freeze" },
    });
    expect(h.state.commit).not.toHaveBeenCalled();
  });

  it("rejects same-version artifact identity mutation before changing trusted state", async () => {
    const baseline = checked("1.4.2", 42, A, B);
    const h = harness(trusted(baseline));
    const mutated = checked("1.4.2", 43, A, "c".repeat(64));
    mutated.artifact.url =
      "https://updates.example.test/home-worker/releases/replaced.tar.gz";
    verifyFreshAs(h.verifier, mutated);

    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "metadata-equivocation" },
    });
    expect(h.state.commit).not.toHaveBeenCalled();
    expect(h.installed.loadCurrent).not.toHaveBeenCalled();
  });

  it("does not mutate state from a structurally parsed but unverifiable cache", async () => {
    const h = harness();
    vi.mocked(h.verifier.verify)
      .mockImplementationOnce(() => {
        throw new SignedEnvelopeVerificationError("signature-invalid");
      })
      .mockReturnValueOnce(verified(checked("1.4.3", 43, B, "c".repeat(64))));

    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "signature-invalid" },
    });
    expect(h.state.commit).not.toHaveBeenCalled();
    expect(h.installed.loadCurrent).not.toHaveBeenCalled();
  });

  it("rejects lower and same-version changed metadata before mutation", async () => {
    const h = harness();
    verifyFreshAs(h.verifier, checked("1.4.2", 41, A, "d".repeat(64)));
    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "metadata-rollback" },
    });

    verifyFreshAs(h.verifier, checked("1.4.2", 42, A, "e".repeat(64)));
    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "metadata-equivocation" },
    });
    expect(h.state.commit).not.toHaveBeenCalled();
  });

  it("refreshes identical artifacts while preserving ledger provenance", async () => {
    const h = harness();
    const refresh = checked("1.4.2", 43, A, "c".repeat(64));
    verifyFreshAs(h.verifier, refresh);

    expect((await h.useCase.execute()).kind).toBe("current");
    const committed = vi.mocked(h.state.commit).mock.calls[0][0];
    expect(committed.artifacts).toEqual(trusted().artifacts);
    expect(committed.highestMetadata).toEqual({
      metadataVersion: 43,
      payloadSha256: "c".repeat(64),
    });
  });

  it("refreshes exact outer bytes and ETag for an identical verified 200", async () => {
    const h = harness();
    vi.mocked(h.verifier.verify)
      .mockReturnValueOnce(verified(checked()))
      .mockReturnValueOnce(verified(checked(), Buffer.from("fresh")));

    await h.useCase.execute();

    const committed = vi.mocked(h.state.commit).mock.calls[0][0];
    expect(committed.highestMetadata).toEqual(trusted().highestMetadata);
    expect(committed.artifacts).toEqual(trusted().artifacts);
    expect(committed.envelope).toEqual({
      bytes: Buffer.from("fresh").toString("base64"),
      etag: '"v43"',
    });
  });

  it("commits verified metadata before classifying a signed installed downgrade as current", async () => {
    const h = harness();
    verifyFreshAs(h.verifier, checked("1.3.9", 43, B, "c".repeat(64)));
    vi.mocked(h.installed.loadCurrent).mockImplementation(async () => {
      h.order.push("installed");
      return artifact("1.4.2", A);
    });

    expect((await h.useCase.execute()).kind).toBe("current");
    expect(h.order).toEqual(["commit", "installed"]);
  });

  it("fails closed on prerelease/schema verification and commit failure", async () => {
    const h = harness();
    vi.mocked(h.verifier.verify).mockImplementation((bytes) => {
      if (Buffer.from(bytes).toString("utf8") === "cached")
        return verified(checked(), Buffer.from("cached"));
      throw new SignedEnvelopeVerificationError("schema-invalid");
    });
    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "schema-invalid" },
    });
    expect(h.state.commit).not.toHaveBeenCalled();

    verifyFreshAs(h.verifier, checked("1.4.3", 43, B, "c".repeat(64)));
    vi.mocked(h.state.commit).mockRejectedValueOnce(new Error("disk"));
    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "maintenance-required" },
    });
    expect(h.installed.loadCurrent).not.toHaveBeenCalled();
  });

  it("reports metadata freeze when expired cache and network fetch fail", async () => {
    const h = harness();
    vi.mocked(h.transport.fetchEnvelope).mockRejectedValue(
      new Error("offline"),
    );
    vi.mocked(h.verifier.verify).mockImplementation(() => {
      throw new SignedEnvelopeVerificationError("metadata-expired");
    });

    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "metadata-freeze" },
    });
    expect(h.state.commit).not.toHaveBeenCalled();
  });

  it("returns routine pre-expiry network failures without mutating signed state", async () => {
    const h = harness();
    vi.mocked(h.transport.fetchEnvelope).mockRejectedValue(
      Object.assign(new Error("offline"), { code: "network-unavailable" }),
    );
    vi.mocked(h.verifier.verify).mockReturnValue(verified(checked()));

    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "network-unavailable" },
    });
    expect(h.state.commit).not.toHaveBeenCalled();
  });

  it("persists a due six-hour effective-time anchor after a verified-cache network failure", async () => {
    const old = trusted();
    old.timeAnchor = {
      ...old.timeAnchor,
      wallMs: CHECK_MS - 6 * 60 * 60 * 1000,
      persistedAtMs: CHECK_MS - 6 * 60 * 60 * 1000,
      monotonicMs: 1_000,
    };
    const { checksum: _checksum, ...oldPayload } = old;
    const h = harness(checksummed(oldPayload));
    vi.mocked(h.transport.fetchEnvelope).mockRejectedValue(
      Object.assign(new Error("offline"), { code: "network-timeout" }),
    );
    vi.mocked(h.verifier.verify).mockReturnValue(verified(checked()));

    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "network-timeout" },
    });
    const committed = vi.mocked(h.state.commit).mock.calls[0][0];
    expect(committed.highestMetadata).toEqual(old.highestMetadata);
    expect(committed.envelope).toEqual(old.envelope);
    expect(committed.artifacts).toEqual(old.artifacts);
    expect(committed.timeAnchor.persistedAtMs).toBe(CHECK_MS);
  });

  it("fails closed on lost state without seeding from the feed", async () => {
    const h = harness();
    vi.mocked(h.state.load).mockRejectedValue(new Error("trust-state-lost"));

    expect(await h.useCase.execute()).toEqual({
      kind: "failure",
      failure: { code: "trust-state-lost" },
    });
    expect(h.transport.fetchEnvelope).not.toHaveBeenCalled();
    expect(h.state.commit).not.toHaveBeenCalled();
  });

  it("single-flights direct and scheduled callers", async () => {
    const h = harness();
    let releaseFetch!: (value: {
      kind: "ok";
      bytes: Buffer;
      etag: string;
    }) => void;
    vi.mocked(h.transport.fetchEnvelope).mockReturnValue(
      new Promise((resolve) => {
        releaseFetch = resolve;
      }),
    );

    const first = h.useCase.execute();
    const second = h.useCase.execute();
    releaseFetch({ kind: "ok", bytes: Buffer.from("fresh"), etag: '"v43"' });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(h.transport.fetchEnvelope).toHaveBeenCalledTimes(1);
    expect(h.state.commit).toHaveBeenCalledTimes(1);
    expect(h.installed.loadCurrent).toHaveBeenCalledTimes(1);
  });

  it("durably claims each release and each distinct failure once", async () => {
    const h = harness();
    const available = checked("1.4.3", 43, B, "c".repeat(64));
    verifyFreshAs(h.verifier, available);
    const result = await h.useCase.execute();
    if (result.kind !== "available") throw new Error("expected available");

    expect(
      await h.useCase.claimAvailableNotification(
        result.available,
        new Date(CHECK_MS),
      ),
    ).toBe(true);
    expect(
      await h.useCase.claimAvailableNotification(
        result.available,
        new Date(CHECK_MS),
      ),
    ).toBe(false);
    expect(
      await h.useCase.claimFailureNotification(
        "signature-invalid",
        new Date(CHECK_MS),
      ),
    ).toBe(true);
    expect(
      await h.useCase.claimFailureNotification(
        "signature-invalid",
        new Date(CHECK_MS),
      ),
    ).toBe(false);
    expect(
      await h.useCase.claimFailureNotification(
        "metadata-rollback",
        new Date(CHECK_MS),
      ),
    ).toBe(true);
    expect(h.current().lastNotification).toEqual({
      version: "1.4.3",
      artifactSha256: B,
    });
    expect(h.current().failureDays).toEqual([
      { day: "2030-01-15", codes: ["signature-invalid", "metadata-rollback"] },
    ]);
  });
});
