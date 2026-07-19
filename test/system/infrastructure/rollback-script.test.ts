import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("rollback.sh maintenance boundary", () => {
  it("contains guidance only and no unauthenticated mutation path", () => {
    const script = readFileSync(resolve("scripts/rollback.sh"), "utf8");

    expect(script).toContain("authenticated maintenance workflow");
    expect(script).not.toMatch(/\b(?:git|tar|pm2|sqlite3)\b/);
  });
});
