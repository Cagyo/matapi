import { Inject, Injectable } from "@nestjs/common";
import {
  artifactLedgerIdentitySha256,
  parseTrustedState,
  type CheckedReleaseIdentity,
  type TrustedArtifact,
  type TrustedState,
  type UpdateCheck,
} from "../domain/ota-contracts";
import {
  captureEffectiveCheckTime,
  shouldPersistTimeAnchor,
} from "../domain/effective-time";
import {
  isOtaFailureCode,
  type OtaFailure,
  type OtaFailureCode,
} from "../domain/ota-failure";
import {
  INSTALLED_RELEASE,
  InstalledReleaseError,
  type InstalledReleasePort,
} from "../domain/ports/installed-release.port";
import { OTA_CLOCK, type OtaClockPort } from "../domain/ports/ota-clock.port";
import {
  RELEASE_FEED_TRANSPORT,
  ReleaseFeedTransportError,
  type FetchEnvelopeResult,
  type ReleaseFeedTransportPort,
} from "../domain/ports/release-feed-transport.port";
import {
  SIGNED_ENVELOPE_VERIFIER,
  SignedEnvelopeVerificationError,
  type SignedEnvelopeVerifierPort,
} from "../domain/ports/signed-envelope-verifier.port";
import {
  TRUSTED_STATE,
  TrustedStateLostError,
  type TrustedStateCommit,
  type TrustedStatePort,
} from "../domain/ports/trusted-state.port";
import {
  classifyStableRelease,
  type ManifestPolicy,
  type VerifiedEnvelope,
} from "../domain/signed-manifest";
import {
  UPDATE_CHECK_OPTIONS,
  type UpdateCheckOptions,
} from "./ports/update-check-options.port";
import { UPDATE_MANIFEST_POLICY } from "./ports/update-manifest-policy.port";

type CacheVerification =
  | { kind: "valid"; verified: VerifiedEnvelope }
  | { kind: "invalid"; code: OtaFailureCode };

function failure(code: OtaFailureCode): UpdateCheck {
  return { kind: "failure", failure: { code } as OtaFailure };
}

function trustedCommit(state: TrustedState): TrustedStateCommit {
  const { checksum: _checksum, ...commit } = state;
  return commit;
}

function errorCode(error: unknown): OtaFailureCode | null {
  if (
    error instanceof SignedEnvelopeVerificationError ||
    error instanceof ReleaseFeedTransportError
  ) {
    return error.code;
  }
  if (error instanceof TrustedStateLostError) return "trust-state-lost";
  if (error instanceof InstalledReleaseError) return "maintenance-required";
  const candidate = (error as { code?: unknown }).code;
  if (isOtaFailureCode(candidate)) return candidate;
  if (error instanceof Error && error.message === "trust-state-lost")
    return "trust-state-lost";
  return null;
}

function artifactCoordinates(
  entry: Pick<TrustedArtifact, "channel" | "targetName" | "version">,
): string {
  return JSON.stringify([entry.channel, entry.targetName, entry.version]);
}

function selectedLedgerEntry(release: CheckedReleaseIdentity): TrustedArtifact {
  return {
    channel: "stable",
    targetName: release.artifact.targetName,
    version: release.artifact.version,
    artifactIdentitySha256: artifactLedgerIdentitySha256(
      "stable",
      release.artifact,
    ),
    artifactSha256: release.artifact.sha256,
    firstMetadataSha256: release.metadata.payloadSha256,
  };
}

function sameLedgerIdentity(
  left: TrustedArtifact,
  right: TrustedArtifact,
): boolean {
  return (
    left.channel === right.channel &&
    left.targetName === right.targetName &&
    left.version === right.version &&
    left.artifactIdentitySha256 === right.artifactIdentitySha256 &&
    left.artifactSha256 === right.artifactSha256
  );
}

function validateCachedProvenance(
  state: TrustedState,
  verified: VerifiedEnvelope,
): OtaFailureCode | null {
  const release = verified.checkedRelease;
  if (
    release.metadata.metadataVersion !==
      state.highestMetadata.metadataVersion ||
    verified.payloadSha256 !== state.highestMetadata.payloadSha256 ||
    release.metadata.payloadSha256 !== state.highestMetadata.payloadSha256
  ) {
    return "metadata-equivocation";
  }
  const expected = selectedLedgerEntry(release);
  const matches = state.artifacts.filter(
    (entry) => artifactCoordinates(entry) === artifactCoordinates(expected),
  );
  if (matches.length !== 1 || !sameLedgerIdentity(matches[0], expected))
    return "metadata-equivocation";
  const coordinates = new Set<string>();
  for (const entry of state.artifacts) {
    const key = artifactCoordinates(entry);
    if (
      coordinates.has(key) ||
      entry.targetName !== release.artifact.targetName
    )
      return "metadata-equivocation";
    coordinates.add(key);
  }
  return null;
}

function nextArtifacts(
  state: TrustedState,
  release: CheckedReleaseIdentity,
): TrustedArtifact[] | null {
  const selected = selectedLedgerEntry(release);
  const existing = state.artifacts.find(
    (entry) => artifactCoordinates(entry) === artifactCoordinates(selected),
  );
  if (existing !== undefined) {
    return sameLedgerIdentity(existing, selected)
      ? state.artifacts.map((entry) => ({ ...entry }))
      : null;
  }
  if (release.metadata.metadataVersion <= state.highestMetadata.metadataVersion)
    return null;
  return [...state.artifacts.map((entry) => ({ ...entry })), selected];
}

@Injectable()
export class CheckForUpdatesUseCase {
  private inFlight: Promise<UpdateCheck> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    @Inject(RELEASE_FEED_TRANSPORT)
    private readonly transport: ReleaseFeedTransportPort,
    @Inject(TRUSTED_STATE) private readonly state: TrustedStatePort,
    @Inject(OTA_CLOCK) private readonly clock: OtaClockPort,
    @Inject(SIGNED_ENVELOPE_VERIFIER)
    private readonly verifier: SignedEnvelopeVerifierPort,
    @Inject(INSTALLED_RELEASE)
    private readonly installed: InstalledReleasePort,
    @Inject(UPDATE_MANIFEST_POLICY)
    private readonly policy: ManifestPolicy,
    @Inject(UPDATE_CHECK_OPTIONS)
    private readonly options: UpdateCheckOptions,
  ) {}

  execute(): Promise<UpdateCheck> {
    if (this.inFlight !== null) return this.inFlight;
    const flight = this.serialize(() => this.executeOnce());
    this.inFlight = flight;
    void flight.then(
      () => {
        if (this.inFlight === flight) this.inFlight = null;
      },
      () => {
        if (this.inFlight === flight) this.inFlight = null;
      },
    );
    return flight;
  }

  claimAvailableNotification(
    release: CheckedReleaseIdentity,
    at: Date,
  ): Promise<boolean> {
    return this.serialize(async () => {
      const current = parseTrustedState(await this.state.load());
      const expected = selectedLedgerEntry(release);
      const ledger = current.artifacts.find(
        (entry) => artifactCoordinates(entry) === artifactCoordinates(expected),
      );
      if (ledger === undefined || !sameLedgerIdentity(ledger, expected))
        return false;
      if (
        current.lastNotification?.version === release.artifact.version &&
        current.lastNotification.artifactSha256 === release.artifact.sha256
      ) {
        return false;
      }
      await this.state.commit({
        ...trustedCommit(current),
        generation: current.generation + 1,
        writtenAt: at.toISOString(),
        lastNotification: {
          version: release.artifact.version,
          artifactSha256: release.artifact.sha256,
        },
      });
      return true;
    });
  }

  claimFailureNotification(code: OtaFailureCode, at: Date): Promise<boolean> {
    return this.serialize(async () => {
      const current = parseTrustedState(await this.state.load());
      const day = at.toISOString().slice(0, 10);
      const existing = current.failureDays.find((entry) => entry.day === day);
      if (existing?.codes.includes(code)) return false;
      const failureDays = current.failureDays
        .filter((entry) => entry.day !== day)
        .map((entry) => ({ day: entry.day, codes: [...entry.codes] }));
      failureDays.push({ day, codes: [...(existing?.codes ?? []), code] });
      failureDays.sort((left, right) => left.day.localeCompare(right.day));
      await this.state.commit({
        ...trustedCommit(current),
        generation: current.generation + 1,
        writtenAt: at.toISOString(),
        failureDays: failureDays.slice(-31),
      });
      return true;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async executeOnce(): Promise<UpdateCheck> {
    let current: TrustedState;
    try {
      current = parseTrustedState(await this.state.load());
    } catch (error) {
      return failure(
        errorCode(error) === "maintenance-required"
          ? "maintenance-required"
          : "trust-state-lost",
      );
    }

    let effective;
    try {
      effective = await captureEffectiveCheckTime(
        this.clock,
        current.timeAnchor,
      );
    } catch (error) {
      return failure(errorCode(error) ?? "maintenance-required");
    }

    const fetchRequest = (etag: string | null) => ({
      url: this.options.feedUrl,
      maxBytes: this.options.maxEnvelopeBytes,
      timeouts: this.options.timeouts,
      etag,
    });
    const baselineCache = this.verifyCache(current, effective.checkTime);

    let fetched: FetchEnvelopeResult;
    try {
      fetched = await this.transport.fetchEnvelope(
        fetchRequest(current.envelope.etag),
      );
    } catch (error) {
      const cached = baselineCache;
      if (cached.kind === "invalid") {
        return failure(
          cached.code === "metadata-expired" ? "metadata-freeze" : cached.code,
        );
      }
      if (
        shouldPersistTimeAnchor({
          metadataAdvanced: false,
          effectiveMs: effective.effectiveMs,
          priorAnchor: current.timeAnchor,
        })
      ) {
        try {
          await this.state.commit({
            ...trustedCommit(current),
            generation: current.generation + 1,
            writtenAt: effective.checkTime.toISOString(),
            timeAnchor: effective.anchor,
          });
        } catch {
          return failure("maintenance-required");
        }
      }
      return failure(errorCode(error) ?? "network-unavailable");
    }

    let verified: VerifiedEnvelope;
    let envelopeBytes: Buffer;
    let etag: string;
    if (fetched.kind === "not-modified") {
      const cached = baselineCache;
      if (cached.kind === "valid") {
        verified = cached.verified;
        envelopeBytes = Buffer.from(current.envelope.bytes, "base64");
        etag = current.envelope.etag;
      } else {
        let fallback: FetchEnvelopeResult;
        try {
          fallback = await this.transport.fetchEnvelope(fetchRequest(null));
        } catch {
          return failure(
            cached.code === "metadata-expired"
              ? "metadata-freeze"
              : cached.code,
          );
        }
        if (fallback.kind === "not-modified") return failure("http-status");
        const fallbackVerified = this.verifyFresh(
          fallback.bytes,
          effective.checkTime,
        );
        if (fallbackVerified.kind === "invalid")
          return failure(fallbackVerified.code);
        verified = fallbackVerified.verified;
        envelopeBytes = Buffer.from(fallback.bytes);
        etag = fallback.etag;
      }
    } else {
      if (
        baselineCache.kind === "invalid" &&
        baselineCache.code !== "metadata-expired"
      ) {
        return failure(baselineCache.code);
      }
      const fresh = this.verifyFresh(fetched.bytes, effective.checkTime);
      if (fresh.kind === "invalid") return failure(fresh.code);
      verified = fresh.verified;
      envelopeBytes = Buffer.from(fetched.bytes);
      etag = fetched.etag;
    }

    const release = verified.checkedRelease;
    if (
      release.metadata.metadataVersion < current.highestMetadata.metadataVersion
    )
      return failure("metadata-rollback");
    if (
      release.metadata.metadataVersion ===
        current.highestMetadata.metadataVersion &&
      verified.payloadSha256 !== current.highestMetadata.payloadSha256
    ) {
      return failure("metadata-equivocation");
    }
    const artifacts = nextArtifacts(current, release);
    if (artifacts === null) return failure("metadata-equivocation");

    try {
      await this.state.commit({
        ...trustedCommit(current),
        generation: current.generation + 1,
        writtenAt: effective.checkTime.toISOString(),
        highestMetadata: {
          metadataVersion: release.metadata.metadataVersion,
          payloadSha256: verified.payloadSha256,
        },
        envelope: {
          bytes: envelopeBytes.toString("base64"),
          etag,
        },
        timeAnchor: effective.anchor,
        artifacts,
      });
    } catch {
      return failure("maintenance-required");
    }

    let installed;
    try {
      installed = await this.installed.loadCurrent();
    } catch (error) {
      return failure(errorCode(error) ?? "maintenance-required");
    }
    let decision;
    try {
      decision = classifyStableRelease(
        installed.version,
        release.artifact.version,
      );
    } catch {
      return failure("maintenance-required");
    }
    return decision === "upgrade"
      ? { kind: "available", installed, available: release }
      : { kind: "current", installed, checked: release };
  }

  private verifyCache(state: TrustedState, checkTime: Date): CacheVerification {
    const result = this.verifyFresh(
      Buffer.from(state.envelope.bytes, "base64"),
      checkTime,
    );
    if (result.kind === "invalid") return result;
    const code = validateCachedProvenance(state, result.verified);
    return code === null ? result : { kind: "invalid", code };
  }

  private verifyFresh(bytes: Uint8Array, checkTime: Date): CacheVerification {
    try {
      return {
        kind: "valid",
        verified: this.verifier.verify(bytes, this.policy, checkTime),
      };
    } catch (error) {
      return { kind: "invalid", code: errorCode(error) ?? "schema-invalid" };
    }
  }
}
