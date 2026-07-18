import { createHash } from "node:crypto";
import type {
  ArtifactMarker,
  CheckedReleaseIdentity,
  KnownGoodMarker,
  OperationJournal,
  OtaOperationReceipt,
  OtaOperationRequest,
  TrustedArtifact,
  TrustedState,
} from "../domain/ota-contracts";
import { artifactLedgerIdentitySha256 } from "../domain/ota-contracts";
import { captureEffectiveCheckTime } from "../domain/effective-time";
import type { OtaFailureCode } from "../domain/ota-failure";
import type { OtaClockPort } from "../domain/ports/ota-clock.port";
import type { ReleaseFeedTransportPort } from "../domain/ports/release-feed-transport.port";
import type { SignedEnvelopeVerifierPort } from "../domain/ports/signed-envelope-verifier.port";
import type { TrustedStatePort } from "../domain/ports/trusted-state.port";
import type { PreparedTreeGateway } from "../domain/prepared-tree";
import {
  artifactDirectoryName,
  sameArtifact,
  sameCheckedRelease,
  sameMetadata,
} from "../domain/release-identity";
import type { ManifestPolicy } from "../domain/signed-manifest";
import type {
  OperationJournalInput,
  OperationJournalTransitionUpdate,
} from "./dual-slot-operation-journal";

export class OtaUpdaterError extends Error {
  constructor(readonly code: OtaFailureCode) {
    super(code);
    this.name = "OtaUpdaterError";
  }
}

export interface OtaUpdaterRequestPort {
  load(operationId: string): Promise<OtaOperationRequest>;
}

export interface OtaUpdaterJournalPort {
  load(): Promise<OperationJournal | null>;
  start(input: OperationJournalInput): Promise<OperationJournal>;
  transition(
    current: OperationJournal,
    phase: OperationJournal["phase"],
    update?: OperationJournalTransitionUpdate,
  ): Promise<OperationJournal>;
}

export interface OtaUpdaterHandshakePort {
  write(fd: number, receipt: OtaOperationReceipt): Promise<void>;
}

export interface ReleasePointers {
  current: string | null;
  previous: string | null;
}

export type CandidateInspection =
  | { kind: "absent" }
  | { kind: "incomplete"; path: string; referenced: boolean }
  | {
      kind: "known-good";
      path: string;
      artifactState: ArtifactMarker;
      artifactEnvelope: Uint8Array;
      knownGood: KnownGoodMarker;
    };

export interface OtaUpdaterTemporary {
  directory: string;
  artifactPath: string;
}

export interface OtaUpdaterLayoutPort {
  capturePointers(): Promise<ReleasePointers>;
  inspectCandidate(candidate: string): Promise<CandidateInspection>;
  removeIncomplete(candidate: string): Promise<void>;
  createTemporary(operationId: string): Promise<OtaUpdaterTemporary>;
  reserveCandidate(candidate: string): Promise<string>;
  writePreparationMarker(path: string, marker: ArtifactMarker): Promise<void>;
  createSharedLinks(path: string): Promise<void>;
  writeFinalMarkers(input: {
    path: string;
    marker: ArtifactMarker;
    envelopeBytes: Uint8Array;
  }): Promise<void>;
  cleanupTemporary(temporary: OtaUpdaterTemporary): Promise<void>;
}

export interface OtaUpdaterStoragePort {
  preflight(input: {
    release: CheckedReleaseIdentity;
    candidate: string;
    pointers: ReleasePointers;
  }): Promise<void>;
  enforceDuringPreparation<T>(
    operation: (checkpoint: () => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

export interface OtaUpdaterArchivePort {
  extract(input: {
    archivePath: string;
    destinationRoot: string;
    release: CheckedReleaseIdentity;
  }): Promise<void>;
}

export interface OtaUpdaterCacheInventory {
  archives: readonly { path: string; size: number; sha256: string }[];
  entryCount: number;
  expandedBytes: number;
  sha256: string;
}

export interface OtaUpdaterCachePort {
  inspect(
    candidatePath: string,
    release: CheckedReleaseIdentity,
  ): Promise<OtaUpdaterCacheInventory>;
}

export interface OtaUpdaterPreparationPort {
  start(input: {
    operationId: string;
    candidate: string;
    candidatePath: string;
    artifactSha256: string;
    metadataSha256: string;
    inventorySha256: string;
  }): Promise<void>;
}

export interface OtaUpdaterDependencies {
  policy: ManifestPolicy;
  requests: OtaUpdaterRequestPort;
  journal: OtaUpdaterJournalPort;
  handshake: OtaUpdaterHandshakePort;
  trusted: Pick<TrustedStatePort, "load">;
  clock: OtaClockPort;
  verifier: SignedEnvelopeVerifierPort;
  layout: OtaUpdaterLayoutPort;
  storage: OtaUpdaterStoragePort;
  transport: ReleaseFeedTransportPort;
  archive: OtaUpdaterArchivePort;
  cache: OtaUpdaterCachePort;
  preparation: OtaUpdaterPreparationPort;
  tree: PreparedTreeGateway;
}

function fail(code: OtaFailureCode): never {
  throw new OtaUpdaterError(code);
}

function selectedLedger(
  state: TrustedState,
  release: CheckedReleaseIdentity,
): TrustedArtifact {
  const selected = state.artifacts.filter(
    (entry) =>
      entry.channel === "stable" &&
      entry.targetName === release.artifact.targetName &&
      entry.version === release.artifact.version,
  );
  if (
    selected.length !== 1 ||
    selected[0].artifactSha256 !== release.artifact.sha256 ||
    selected[0].artifactIdentitySha256 !==
      artifactLedgerIdentitySha256("stable", release.artifact)
  ) {
    fail("metadata-equivocation");
  }
  return selected[0];
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function markerFor(
  release: CheckedReleaseIdentity,
  envelopeBytes: Uint8Array,
  treeSha256: string,
  writtenAt: string,
): ArtifactMarker {
  return {
    schemaVersion: 1,
    artifact: release.artifact,
    metadata: release.metadata,
    envelopeSha256: createHash("sha256").update(envelopeBytes).digest("hex"),
    preparedTreeSha256: treeSha256,
    writtenAt,
  };
}

function maintenance(error: unknown): never {
  if (error instanceof OtaUpdaterError) throw error;
  fail("maintenance-required");
}

export class OtaUpdaterService {
  constructor(private readonly dependencies: OtaUpdaterDependencies) {}

  async run(operationId: string, handshakeFd: number): Promise<void> {
    const request = await this.dependencies.requests
      .load(operationId)
      .catch(maintenance);
    if (
      request.operationId !== operationId ||
      request.kind !== "update" ||
      request.expected === null
    ) {
      fail("maintenance-required");
    }

    let existing: OperationJournal | null;
    try {
      existing = await this.dependencies.journal.load();
    } catch (error) {
      maintenance(error);
    }
    if (existing !== null) fail("maintenance-required");

    const candidate = artifactDirectoryName(request.expected.artifact);
    const pointers = await this.dependencies.layout
      .capturePointers()
      .catch(maintenance);
    const preparing = await this.dependencies.journal
      .start({
        schemaVersion: 1,
        operationId,
        kind: "update",
        phase: "preparing",
        expected: request.expected,
        acceptedAt: request.acceptedAt,
        requestSha256: request.requestSha256,
        receiptGeneration: 1,
        priorCurrent: pointers.current,
        priorPrevious: pointers.previous,
        candidate,
        preparedTreeSha256: null,
        diagnostics: { code: null, notes: [] },
        updatedAt: request.acceptedAt,
      })
      .catch(maintenance);
    if (
      preparing.generation !== preparing.receiptGeneration ||
      preparing.operationId !== request.operationId ||
      preparing.kind !== request.kind ||
      preparing.expected === null ||
      !sameCheckedRelease(preparing.expected, request.expected) ||
      preparing.acceptedAt !== request.acceptedAt ||
      preparing.requestSha256 !== request.requestSha256 ||
      preparing.candidate !== candidate ||
      preparing.priorCurrent !== pointers.current ||
      preparing.priorPrevious !== pointers.previous
    ) {
      fail("maintenance-required");
    }
    await this.dependencies.handshake.write(handshakeFd, {
      schemaVersion: 1,
      operationId,
      kind: "update",
      acceptedAt: preparing.acceptedAt,
      requestSha256: preparing.requestSha256,
      receiptGeneration: preparing.receiptGeneration,
    });

    const trusted = await this.dependencies.trusted.load().catch(maintenance);
    const effective = await captureEffectiveCheckTime(
      this.dependencies.clock,
      trusted.timeAnchor,
    ).catch((error: unknown) => {
      const code = (error as { code?: unknown }).code;
      if (code === "clock-unsynchronized" || code === "clock-rollback") {
        fail(code);
      }
      maintenance(error);
    });
    const cachedEnvelope = Buffer.from(trusted.envelope.bytes, "base64");
    let verified;
    try {
      verified = this.dependencies.verifier.verify(
        cachedEnvelope,
        this.dependencies.policy,
        effective.checkTime,
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string") fail(code as OtaFailureCode);
      maintenance(error);
    }
    if (
      !exactBytes(verified.outerBytes, cachedEnvelope) ||
      !sameCheckedRelease(verified.checkedRelease, request.expected) ||
      verified.payloadSha256 !== trusted.highestMetadata.payloadSha256 ||
      request.expected.metadata.metadataVersion !==
        trusted.highestMetadata.metadataVersion
    ) {
      fail("metadata-equivocation");
    }
    const ledger = selectedLedger(trusted, request.expected);
    if (ledger.firstMetadataSha256 !== verified.payloadSha256) {
      fail("metadata-equivocation");
    }

    await this.dependencies.storage.preflight({
      release: request.expected,
      candidate,
      pointers,
    });

    const inspected =
      await this.dependencies.layout.inspectCandidate(candidate);
    if (inspected.kind === "known-good") {
      await this.reuseKnownGood(
        preparing,
        request.expected,
        ledger,
        inspected,
        effective.checkTime,
      );
      return;
    }
    if (inspected.kind === "incomplete") {
      if (inspected.referenced) fail("maintenance-required");
      await this.dependencies.layout.removeIncomplete(candidate);
    }

    const temporary =
      await this.dependencies.layout.createTemporary(operationId);
    try {
      await this.dependencies.storage.enforceDuringPreparation(
        async (checkpoint) => {
          await checkpoint();
          const downloaded = await this.dependencies.transport.downloadArtifact(
            {
              url: request.expected!.artifact.url,
              destination: temporary.artifactPath,
              expectedSize: request.expected!.artifact.size,
              maxBytes: request.expected!.artifact.size,
              timeouts: {
                connectMs: 10_000,
                firstByteMs: 10_000,
                idleMs: 15_000,
                totalMs: 15 * 60_000,
              },
            },
          );
          if (
            downloaded.size !== request.expected!.artifact.size ||
            downloaded.sha256 !== request.expected!.artifact.sha256
          ) {
            fail("archive-integrity");
          }
          await checkpoint();

          const candidatePath =
            await this.dependencies.layout.reserveCandidate(candidate);
          await this.dependencies.archive.extract({
            archivePath: temporary.artifactPath,
            destinationRoot: candidatePath,
            release: request.expected!,
          });
          await checkpoint();
          const inventory = await this.dependencies.cache.inspect(
            candidatePath,
            request.expected!,
          );
          await checkpoint();

          const preliminary = markerFor(
            request.expected!,
            cachedEnvelope,
            "0".repeat(64),
            effective.checkTime.toISOString(),
          );
          await this.dependencies.layout.writePreparationMarker(
            candidatePath,
            preliminary,
          );
          await this.dependencies.preparation.start({
            operationId,
            candidate,
            candidatePath,
            artifactSha256: request.expected!.artifact.sha256,
            metadataSha256: verified.payloadSha256,
            inventorySha256: inventory.sha256,
          });
          await checkpoint();
          await this.dependencies.layout.createSharedLinks(candidatePath);
          await checkpoint();

          const measured =
            await this.dependencies.tree.measureAndDigest(candidatePath);
          if (
            measured.allocatedBytes >
              request.expected!.artifact.maxPreparedSize ||
            measured.entryCount > request.expected!.artifact.maxPreparedFiles
          ) {
            fail("disk-resource");
          }
          const marker = markerFor(
            request.expected!,
            cachedEnvelope,
            measured.sha256,
            effective.checkTime.toISOString(),
          );
          await this.dependencies.layout.writeFinalMarkers({
            path: candidatePath,
            marker,
            envelopeBytes: cachedEnvelope,
          });
          await checkpoint();
          await this.dependencies.tree.flushDurably(candidatePath);
          await checkpoint();
          await this.dependencies.journal.transition(preparing, "prepared", {
            preparedTreeSha256: measured.sha256,
            updatedAt: effective.checkTime.toISOString(),
          });
        },
      );
    } finally {
      await this.dependencies.layout.cleanupTemporary(temporary);
    }
  }

  private async reuseKnownGood(
    journal: OperationJournal,
    expected: CheckedReleaseIdentity,
    ledger: TrustedArtifact,
    candidate: Extract<CandidateInspection, { kind: "known-good" }>,
    checkTime: Date,
  ): Promise<void> {
    try {
      const authorized = this.dependencies.verifier.verify(
        candidate.artifactEnvelope,
        this.dependencies.policy,
        new Date(candidate.artifactState.metadata.publishedAt),
      );
      const markerEnvelopeSha = createHash("sha256")
        .update(candidate.artifactEnvelope)
        .digest("hex");
      const measured = await this.dependencies.tree.measureAndDigest(
        candidate.path,
      );
      if (
        !sameArtifact(candidate.artifactState.artifact, expected.artifact) ||
        !sameArtifact(authorized.checkedRelease.artifact, expected.artifact) ||
        !sameMetadata(
          candidate.artifactState.metadata,
          authorized.checkedRelease.metadata,
        ) ||
        authorized.payloadSha256 !== ledger.firstMetadataSha256 ||
        candidate.artifactState.envelopeSha256 !== markerEnvelopeSha ||
        candidate.artifactState.preparedTreeSha256 !== measured.sha256 ||
        candidate.knownGood.artifactSha256 !== expected.artifact.sha256 ||
        candidate.knownGood.metadataSha256 !== authorized.payloadSha256 ||
        candidate.knownGood.preparedTreeSha256 !== measured.sha256
      ) {
        fail("maintenance-required");
      }
      await this.dependencies.journal.transition(journal, "prepared", {
        preparedTreeSha256: measured.sha256,
        updatedAt: checkTime.toISOString(),
      });
    } catch (error) {
      maintenance(error);
    }
  }
}
