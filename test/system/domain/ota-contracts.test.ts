import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseArtifactIdentity,
  parseArtifactMarker,
  parseCheckedReleaseIdentity,
  parseKnownGoodMarker,
  parseMetadataIdentity,
  parseOtaFailure,
  parseOperationJournal,
  parseOperationState,
  parsePreparationReceipt,
  parseReadinessMarker,
  parseStartupReport,
  parseStrictJson,
  parseTrustedState,
  canTransitionOperationState,
  preservesOperationImmutables,
} from "../../../src/system/domain/ota-contracts";

interface Vector {
  parser: keyof typeof parsers;
  value: unknown;
}

interface VectorFile {
  valid: Vector[];
  invalid: Vector[];
  canonicalChecksums: Record<"trusted-state" | "operation-journal", string>;
  bounds: {
    trustedStateBytes: number;
    artifacts: number;
    failureDays: number;
    diagnosticNotes: number;
    diagnosticNoteBytes: number;
  };
  operationTransitions: {
    phases: (
      | "preparing"
      | "prepared"
      | "failed_pre_activation"
      | "activating"
      | "activated"
      | "rolled_back"
      | "rollback_failed"
      | "healthy"
      | "cleanup_pending"
    )[];
    legal: string[];
  };
  operationImmutableFields: (
    | "operationId"
    | "kind"
    | "expected"
    | "priorCurrent"
    | "priorPrevious"
    | "candidate"
  )[];
}

const parsers = {
  "artifact-identity": parseArtifactIdentity,
  "artifact-marker": parseArtifactMarker,
  "checked-release-identity": parseCheckedReleaseIdentity,
  "known-good-marker": parseKnownGoodMarker,
  "metadata-identity": parseMetadataIdentity,
  "operation-journal": parseOperationJournal,
  "operation-state": parseOperationState,
  "ota-failure": parseOtaFailure,
  "preparation-receipt": parsePreparationReceipt,
  "readiness-marker": parseReadinessMarker,
  "startup-report": parseStartupReport,
  "strict-json": parseStrictJson,
  "trusted-state": parseTrustedState,
};

const vectors = JSON.parse(
  readFileSync(
    resolve("test/fixtures/ota/contracts/schema-v1-vectors.json"),
    "utf8",
  ),
) as VectorFile;

function checksummed<T extends Record<string, unknown>>(value: T): T {
  const payload = { ...value };
  delete payload.checksum;
  return {
    ...value,
    checksum: createHash("sha256")
      .update(JSON.stringify(payload), "utf8")
      .digest("hex"),
  };
}

describe("OTA schema-v1 contracts", () => {
  it.each(["unknown", "prepared_v2", "../shared"])(
    "rejects hostile operation state %s",
    (phase) => {
      expect(() => parseOperationState({ schemaVersion: 1, phase })).toThrow();
    },
  );

  it.each(vectors.valid)(
    "accepts valid $parser vector",
    ({ parser, value }) => {
      expect(() => parsers[parser](value as never)).not.toThrow();
    },
  );

  it.each(vectors.invalid)(
    "rejects invalid $parser vector",
    ({ parser, value }) => {
      expect(() => parsers[parser](value as never)).toThrow();
    },
  );

  it("rejects operation IDs whose final Base64url pad bits are non-canonical", () => {
    expect(() =>
      parseKnownGoodMarker({
        schemaVersion: 1,
        operationId: "AAAAAAAAAAAAAAAAAAAAAB",
        artifactSha256: "a".repeat(64),
        metadataSha256: "b".repeat(64),
        preparedTreeSha256: "c".repeat(64),
        activatedAt: "2030-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it.each(["9007199254740992", "-9007199254740992", "1e400"])(
    "rejects unsafe integer JSON literal %s",
    (value) => {
      expect(() => parseStrictJson(value)).toThrow();
    },
  );

  it("rejects a checksummed document with re-ordered nested keys", () => {
    const trusted = vectors.valid.find(
      (vector) => vector.parser === "trusted-state",
    )?.value as Record<string, unknown>;
    const reordered = {
      ...trusted,
      envelope: {
        etag: (trusted.envelope as Record<string, unknown>).etag,
        bytes: (trusted.envelope as Record<string, unknown>).bytes,
      },
    };
    const payload = { ...reordered };
    delete payload.checksum;
    reordered.checksum = createHash("sha256")
      .update(JSON.stringify(payload), "utf8")
      .digest("hex");

    expect(() => parseTrustedState(reordered)).toThrow();
  });

  it("permits exactly the legal operation-state transitions", () => {
    const { phases, legal } = vectors.operationTransitions;
    const legalTransitions = new Set(legal);

    for (const from of phases) {
      for (const to of phases) {
        expect(canTransitionOperationState(from, to)).toBe(
          legalTransitions.has(`${from}:${to}`),
        );
      }
    }
  });

  it("requires operation-journal immutable fields to stay fixed after generation one", () => {
    const journal = parseOperationJournal(
      vectors.valid.find((vector) => vector.parser === "operation-journal")
        ?.value,
    );
    const next = { ...journal, generation: 2 };
    expect(preservesOperationImmutables(journal, next)).toBe(true);
    const changed: Record<
      (typeof vectors.operationImmutableFields)[number],
      unknown
    > = {
      operationId: "BcCdEfGhIjKlMnOpQrStUw",
      kind: "rollback",
      expected: {
        artifact: {
          version: "1.4.2",
          commit: "0123456789abcdef0123456789abcdef01234567",
          targetName: "linux-arm",
          target: {
            platform: "linux",
            arch: "arm",
            libc: "glibc",
            libcMinVersion: "2.28",
            nodeModulesAbi: "115",
          },
          url: "https://updates.example.test/home-worker-1.4.2.tar.gz",
          format: "tar.gz",
          size: 10,
          expandedSize: 20,
          maxPreparedSize: 30,
          maxPreparedFiles: 40,
          fileCount: 2,
          sha256: "a".repeat(64),
        },
        metadata: {
          metadataVersion: 42,
          channel: "stable",
          payloadSha256: "b".repeat(64),
          publishedAt: "2030-01-01T00:00:00.000Z",
          expiresAt: "2030-01-02T00:00:00.000Z",
        },
      },
      priorCurrent: `1.5.0-${"a".repeat(64)}`,
      priorPrevious: `1.5.0-${"a".repeat(64)}`,
      candidate: `1.5.0-${"a".repeat(64)}`,
    };
    for (const field of vectors.operationImmutableFields) {
      expect(
        preservesOperationImmutables(journal, {
          ...next,
          [field]: changed[field],
        }),
      ).toBe(false);
    }
  });

  it("matches the independently declared canonical checksums", () => {
    for (const parser of ["trusted-state", "operation-journal"] as const) {
      const value = vectors.valid.find((vector) => vector.parser === parser)
        ?.value as Record<string, unknown>;
      expect(value.checksum).toBe(vectors.canonicalChecksums[parser]);
      expect(checksummed(value).checksum).toBe(
        vectors.canonicalChecksums[parser],
      );
    }
  });

  it("enforces portable trusted-state and journal resource bounds", () => {
    const trusted = vectors.valid.find(
      (vector) => vector.parser === "trusted-state",
    )?.value as Record<string, unknown>;
    const journal = vectors.valid.find(
      (vector) => vector.parser === "operation-journal",
    )?.value as Record<string, unknown>;
    const artifact = (trusted.artifacts as Record<string, unknown>[])[0];
    const failureDay = (trusted.failureDays as Record<string, unknown>[])[0];
    const note = "x".repeat(vectors.bounds.diagnosticNoteBytes);

    const maxArtifacts = checksummed({
      ...trusted,
      artifacts: Array.from(
        { length: vectors.bounds.artifacts },
        () => artifact,
      ),
    });
    const maxFailureDays = checksummed({
      ...trusted,
      failureDays: Array.from(
        { length: vectors.bounds.failureDays },
        () => failureDay,
      ),
    });
    const maxNotes = checksummed({
      ...journal,
      diagnostics: {
        code: null,
        notes: Array.from(
          { length: vectors.bounds.diagnosticNotes },
          () => note,
        ),
      },
    });

    expect(() => parseTrustedState(maxArtifacts)).not.toThrow();
    expect(() => parseTrustedState(maxFailureDays)).not.toThrow();
    expect(() => parseOperationJournal(maxNotes)).not.toThrow();
    expect(() =>
      parseTrustedState(
        checksummed({
          ...maxArtifacts,
          artifacts: [...(maxArtifacts.artifacts as unknown[]), artifact],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseTrustedState(
        checksummed({
          ...maxFailureDays,
          failureDays: [
            ...(maxFailureDays.failureDays as unknown[]),
            failureDay,
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseOperationJournal(
        checksummed({
          ...maxNotes,
          diagnostics: {
            code: null,
            notes: Array.from(
              { length: vectors.bounds.diagnosticNotes + 1 },
              () => note,
            ),
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseTrustedState(
        `${" ".repeat(vectors.bounds.trustedStateBytes + 1)}${JSON.stringify(trusted)}`,
      ),
    ).toThrow();
  });

  it("limits strict JSON nesting depth", () => {
    expect(() =>
      parseStrictJson(`${"[".repeat(65)}0${"]".repeat(65)}`),
    ).toThrow();
  });
});
