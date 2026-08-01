export const ARCHIVE_CLOCK = Symbol('ARCHIVE_CLOCK');

export interface ArchiveClockReading {
  nowMs: number;
  synchronized: boolean;
  plausible: boolean;
  offsetMs: number | null;
}

/** Clock health required before any age-based permanent Drive deletion. */
export interface ArchiveClockPort {
  read(): Promise<ArchiveClockReading>;
}
