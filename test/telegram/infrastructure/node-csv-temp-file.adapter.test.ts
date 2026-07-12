import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CSV_BYTES,
  CsvDocumentTooLargeError,
} from "../../../src/telegram/application/ports/csv-temp-file.port";
import { NodeCsvTempFileAdapter } from "../../../src/telegram/infrastructure/node-csv-temp-file.adapter";

let root: string;
let tempDirectory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "csv-export-"));
  tempDirectory = join(root, "owned");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readAll(
  stream: ReturnType<typeof createReadStream>,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("NodeCsvTempFileAdapter", () => {
  it("removes an incomplete file when output exceeds 8 MiB", async () => {
    const port = new NodeCsvTempFileAdapter(tempDirectory);

    expect(() => port.stage("x.csv", ["x".repeat(MAX_CSV_BYTES + 1)])).toThrow(
      CsvDocumentTooLargeError,
    );
    await expect(readdir(tempDirectory)).resolves.toEqual([]);
  });

  it("accepts output exactly at the 8 MiB byte boundary", async () => {
    const port = new NodeCsvTempFileAdapter(tempDirectory);
    const file = port.stage("x.csv", ["x".repeat(MAX_CSV_BYTES)]);

    expect(await readAll(file.open())).toHaveLength(MAX_CSV_BYTES);
    await file.dispose();
  });

  it("counts UTF-8 bytes rather than JavaScript string length", async () => {
    const port = new NodeCsvTempFileAdapter(tempDirectory);

    expect(() =>
      port.stage("x.csv", ["€".repeat(Math.floor(MAX_CSV_BYTES / 3) + 1)]),
    ).toThrow(CsvDocumentTooLargeError);
    await expect(readdir(tempDirectory)).resolves.toEqual([]);
  });

  it("creates private files and opens independent retry streams", async () => {
    const port = new NodeCsvTempFileAdapter(tempDirectory);
    const file = port.stage("x.csv", ["ok"]);

    expect((await stat(tempDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(tempDirectory, file.filename))).mode & 0o777).toBe(
      0o600,
    );
    expect(await readAll(file.open())).toEqual(await readAll(file.open()));
    await file.dispose();
    await expect(
      lstat(join(tempDirectory, file.filename)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(file.dispose()).resolves.toBeUndefined();
  });

  it("only removes stale regular feature files and leaves symlinks untouched", async () => {
    await mkdir(tempDirectory, { recursive: true });
    const stale = join(tempDirectory, "csv_stale.csv");
    const fresh = join(tempDirectory, "csv_fresh.csv");
    const unrelated = join(tempDirectory, "other.csv");
    const target = join(root, "target.csv");
    const link = join(tempDirectory, "csv_link.csv");
    await Promise.all([
      writeFile(stale, "old"),
      writeFile(fresh, "new"),
      writeFile(unrelated, "old"),
      writeFile(target, "target"),
    ]);
    await symlink(target, link);
    const now = new Date("2030-01-01T02:00:00.000Z");
    const oldSeconds =
      new Date(now.getTime() - 60 * 60 * 1000 - 1).getTime() / 1000;
    const freshSeconds =
      new Date(now.getTime() - 60 * 60 * 1000 + 1).getTime() / 1000;
    await utimes(stale, oldSeconds, oldSeconds);
    await utimes(fresh, freshSeconds, freshSeconds);
    await utimes(unrelated, oldSeconds, oldSeconds);

    await new NodeCsvTempFileAdapter(tempDirectory).cleanupStale(now);

    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(fresh)).resolves.toBeDefined();
    await expect(lstat(unrelated)).resolves.toBeDefined();
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});
