import { constants } from "node:fs";
import { lstat, open, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { StartupReportStorePort } from "../application/consume-startup-report.use-case";
import {
  parseStartupReport,
  parseStrictJson,
  type StartupReport,
} from "../domain/ota-contracts";

const DEFAULT_PATH =
  "/opt/home-worker/shared/update/startup-report.pending.json";
const MAX_BYTES = 64 * 1024;

export class FsStartupReportStore implements StartupReportStorePort {
  constructor(
    private readonly path = DEFAULT_PATH,
    private readonly expectedUid = process.getuid?.(),
  ) {}

  async read(): Promise<unknown> {
    try {
      return await this.readCurrent();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async acknowledge(report: StartupReport): Promise<void> {
    const current = parseStartupReport(await this.readCurrent());
    if (JSON.stringify(current) !== JSON.stringify(report)) {
      throw new Error("startup report changed before acknowledgement");
    }
    const acknowledged = resolve(
      dirname(this.path),
      "startup-report.acked.json",
    );
    await rename(this.path, acknowledged);
    const directory = await open(
      dirname(this.path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async readCurrent(): Promise<unknown> {
    const info = await lstat(this.path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (this.expectedUid !== undefined && info.uid !== this.expectedUid) ||
      (info.mode & 0o022) !== 0 ||
      info.size < 1 ||
      info.size > MAX_BYTES
    ) {
      throw new Error("startup report file is invalid");
    }
    const handle = await open(
      this.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await handle.stat();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error("startup report changed while reading");
      }
      return parseStrictJson(bytes);
    } finally {
      await handle.close();
    }
  }
}
