import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalPreparedTreeSha256,
  encodePreparedTreeRecord,
  isUpdaterMarkerPath,
  normalizePreparedTreeMode,
  type PreparedTreeRecord,
} from "../../../src/system/domain/prepared-tree";

const records: PreparedTreeRecord[] = [
  {
    relativePath: "dist/main.js",
    entryType: "file",
    normalizedMode: "0644",
    contentIdentity: "b".repeat(64),
  },
  {
    relativePath: "dist",
    entryType: "directory",
    normalizedMode: "0755",
    contentIdentity: "",
  },
];

describe("prepared-tree canonical records", () => {
  it("hashes records in raw UTF-8 path-byte order", () => {
    const expected = createHash("sha256")
      .update(encodePreparedTreeRecord(records[1]))
      .update(encodePreparedTreeRecord(records[0]))
      .digest("hex");

    expect(expected).toBe(
      "17444d652e979ab976ae2b96852d8a7f14e7806f83b94d18fe2793be69a2b627",
    );
    expect(canonicalPreparedTreeSha256(records)).toBe(expected);
    expect(canonicalPreparedTreeSha256([...records].reverse())).toBe(expected);
  });

  it("length-prefixes every tuple field without delimiter ambiguity", () => {
    const left = encodePreparedTreeRecord({
      relativePath: "a",
      entryType: "file",
      normalizedMode: "0644",
      contentIdentity: "bc",
    });
    const right = encodePreparedTreeRecord({
      relativePath: "ab",
      entryType: "file",
      normalizedMode: "0644",
      contentIdentity: "c",
    });

    expect(left.equals(right)).toBe(false);
  });

  it("normalizes only the portable permission and special-mode bits", () => {
    expect(normalizePreparedTreeMode(0o100644)).toBe("0644");
    expect(normalizePreparedTreeMode(0o104755)).toBe("4755");
  });

  it.each(["artifact-state.json", "artifact-envelope.json", "known-good.json"])(
    "excludes root updater marker %s",
    (path) => {
      expect(isUpdaterMarkerPath(path)).toBe(true);
    },
  );

  it("does not exclude similarly named or nested artifact files", () => {
    expect(isUpdaterMarkerPath("nested/artifact-state.json")).toBe(false);
    expect(isUpdaterMarkerPath("artifact-state.json.backup")).toBe(false);
  });
});
