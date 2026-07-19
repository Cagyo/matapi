import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("update.sh signed OTA guidance", () => {
  it("only directs operators to the authenticated Telegram update workflow", () => {
    const result = spawnSync("bash", [resolve("scripts/update.sh")], {
      encoding: "utf8",
    });

    expect(result.status).toBe(64);
    expect(`${result.stdout}${result.stderr}`).toContain("/update");
  });

  it("contains no unsigned release, local-copy, database, PM2, or Git fallback", () => {
    const script = readFileSync(resolve("scripts/update.sh"), "utf8");

    expect(script).not.toMatch(
      /\b(?:git|curl|wget|rsync|tar|sqlite3|pm2|yarn|npm)\b/,
    );
    expect(script).not.toContain("HOME_WORKER_RELEASE_URL");
    expect(script).not.toContain("HOME_WORKER_REPO");
  });
});
