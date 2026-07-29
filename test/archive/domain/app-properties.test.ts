import { describe, expect, it } from "vitest";
import {
  encodeArchiveAppProperties,
  matchesArchiveAppProperties,
} from "../../../src/archive/domain/app-properties";

describe("archive app properties", () => {
  it("keeps every app property key plus value within 124 UTF-8 bytes", () => {
    const properties = encodeArchiveAppProperties({
      installationId: "i".repeat(200),
      generationId: "g".repeat(200),
      kind: "motion_video",
      sourceFingerprint: "a".repeat(64),
      sha256: "b".repeat(64),
      sourceTimeMs: 1_787_900_000_000,
      schemaVersion: 1,
    });

    expect(Object.entries(properties)).toHaveLength(7);
    expect(
      Object.entries(properties).every(
        ([key, value]) => Buffer.byteLength(key + value, "utf8") <= 124,
      ),
    ).toBe(true);
  });

  it("does not accept a property set transplanted to another generation", () => {
    const expected = encodeArchiveAppProperties({
      installationId: "installation-1",
      generationId: "generation-1",
      kind: "database_backup",
      sourceFingerprint: "a".repeat(64),
      sha256: "b".repeat(64),
      sourceTimeMs: 1_787_900_000_000,
      schemaVersion: 1,
    });
    const transplanted = { ...expected, a1g: "generation-2" };

    expect(matchesArchiveAppProperties(expected, transplanted)).toBe(false);
  });
});
