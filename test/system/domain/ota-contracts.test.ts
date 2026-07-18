import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseArtifactMarker,
  parseKnownGoodMarker,
  parseOperationJournal,
  parseOperationState,
  parsePreparationReceipt,
  parseReadinessMarker,
  parseStartupReport,
  parseStrictJson,
  parseTrustedState,
} from "../../../src/system/domain/ota-contracts";

interface Vector {
  parser: keyof typeof parsers;
  value: unknown;
}

interface VectorFile {
  valid: Vector[];
  invalid: Vector[];
}

const parsers = {
  "artifact-marker": parseArtifactMarker,
  "known-good-marker": parseKnownGoodMarker,
  "operation-journal": parseOperationJournal,
  "operation-state": parseOperationState,
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
});
