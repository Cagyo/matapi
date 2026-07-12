import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  chmodSync,
  closeSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import {
  CsvDocumentTooLargeError,
  CsvTempFile,
  CsvTempFilePort,
  MAX_CSV_BYTES,
} from "../application/ports/csv-temp-file.port";

const STALE_AFTER_MS = 60 * 60 * 1000;
const FEATURE_FILENAME_PREFIX = "csv_";

@Injectable()
export class NodeCsvTempFileAdapter implements CsvTempFilePort, OnModuleInit {
  constructor(private readonly directory = join(tmpdir(), "home-worker-csv")) {}

  async onModuleInit(): Promise<void> {
    await this.cleanupStale(new Date());
  }

  stage(filename: string, chunks: Iterable<string>): CsvTempFile {
    if (basename(filename) !== filename) {
      throw new TypeError("CSV filename must not contain a path");
    }

    this.ensureDirectory();
    let path: string | undefined;
    let descriptor: number | undefined;
    let writtenBytes = 0;

    try {
      const created = this.createTempFile(filename);
      path = created.path;
      descriptor = created.descriptor;
      for (const chunk of chunks) {
        const chunkBytes = Buffer.byteLength(chunk, "utf8");
        writtenBytes += chunkBytes;
        if (writtenBytes > MAX_CSV_BYTES) {
          throw new CsvDocumentTooLargeError(writtenBytes, MAX_CSV_BYTES);
        }
        writeAll(descriptor, chunk);
      }
      closeSync(descriptor);
      descriptor = undefined;
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The incomplete path is still removed below.
        }
      }
      if (path !== undefined) {
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if (!isMissing(unlinkError) && !(error instanceof Error)) {
            throw unlinkError;
          }
        }
      }
      throw error;
    }

    return new NodeCsvTempFile(filename, path);
  }

  async cleanupStale(now: Date): Promise<void> {
    this.ensureDirectory();
    const cutoff = now.getTime() - STALE_AFTER_MS;

    for (const entry of readdirSync(this.directory)) {
      if (!entry.startsWith(FEATURE_FILENAME_PREFIX)) continue;

      const path = join(this.directory, entry);
      let details;
      try {
        details = lstatSync(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (
        details.isSymbolicLink() ||
        !details.isFile() ||
        details.mtimeMs >= cutoff
      )
        continue;
      unlinkSync(path);
    }
  }

  private ensureDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  private createTempFile(filename: string): { descriptor: number; path: string } {
    for (;;) {
      const path = join(this.directory, `${filename}.${randomUUID()}`);
      try {
        return { path, descriptor: openSync(path, "wx", 0o600) };
      } catch (error) {
        if (isAlreadyExists(error)) continue;
        throw error;
      }
    }
  }
}

class NodeCsvTempFile implements CsvTempFile {
  private disposed = false;

  constructor(
    readonly filename: string,
    private readonly path: string,
  ) {}

  open(): Readable {
    return createReadStream(this.path);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    try {
      unlinkSync(this.path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    this.disposed = true;
  }
}

function writeAll(descriptor: number, chunk: string): void {
  const bytes = Buffer.from(chunk, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written === 0) throw new Error("Failed to write CSV chunk");
    offset += written;
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
