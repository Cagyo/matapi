export const MEDIA_FILE = Symbol('MEDIA_FILE');

/**
 * Filesystem queries over the local Motion storage directory
 * (`MOTION_LOCAL_DIR`). Used by `/camera video`/`photo` (existence + size)
 * and `/camera status` (total local usage). Pure I/O — no daemon control.
 */
export interface MediaFilePort {
  /** Whether a previously recorded media path still exists on disk. */
  exists(path: string): Promise<boolean>;
  /** File size in bytes, or `null` when the file is gone or unreadable. */
  sizeBytes(path: string): Promise<number | null>;
  /** Total bytes used under the Motion storage dir, or `null` on failure. */
  localUsageBytes(): Promise<number | null>;
}
