import { describe, expect, it } from "vitest";
import {
  compareLibcVersions,
  parseLibcVersion,
} from "../../../src/system/domain/libc-version";

describe("libc version", () => {
  it.each([
    "",
    "2",
    "2.",
    ".28",
    "2..28",
    " 2.28",
    "2.28 ",
    "+2.28",
    "2.-28",
    "2.2e1",
    "02.28",
    "2.028",
    "2.٢٨",
    `2.${"1".repeat(31)}`,
  ])("rejects non-canonical runtime value %j", (value) => {
    expect(() => parseLibcVersion(value)).toThrow();
  });

  it("accepts bounded ASCII dotted integers with at least two components", () => {
    expect(parseLibcVersion("2.28")).toBe("2.28");
    expect(parseLibcVersion("2.28.0")).toBe("2.28.0");
    expect(parseLibcVersion(`2.${"9".repeat(29)}`)).toHaveLength(31);
  });

  it("compares huge components exactly without Number precision loss", () => {
    expect(
      compareLibcVersions(
        "2.9007199254740993123456788",
        "2.9007199254740993123456789",
      ),
    ).toBeLessThan(0);
    expect(
      compareLibcVersions(
        "2.9007199254740993123456790",
        "2.9007199254740993123456789",
      ),
    ).toBeGreaterThan(0);
    expect(compareLibcVersions("2.28", "2.28.0")).toBe(0);
  });
});
