import { Readable } from "node:stream";

export const CSV_TEMP_FILE = Symbol("CSV_TEMP_FILE");
export const CSV_TEMP_DIRECTORY = Symbol("CSV_TEMP_DIRECTORY");
export const MAX_CSV_BYTES = 8 * 1024 * 1024;

export class CsvDocumentTooLargeError extends Error {
  readonly code = "CSV_DOCUMENT_TOO_LARGE" as const;

  constructor(
    readonly documentBytes: number,
    readonly maxDocumentBytes: number,
  ) {
    super(
      `CSV document is ${documentBytes} bytes; export limit is ${maxDocumentBytes} bytes`,
    );
    this.name = "CsvDocumentTooLargeError";
  }
}

export interface CsvTempFile {
  readonly filename: string;
  open(): Readable;
  dispose(): Promise<void>;
}

export interface CsvTempFilePort {
  stage(filename: string, chunks: Iterable<string>): CsvTempFile;
  cleanupStale(now: Date): Promise<void>;
}
