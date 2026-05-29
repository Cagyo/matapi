import { MotionEvent } from '../motion-event.entity';

export const MEDIA_WRITER = Symbol('MEDIA_WRITER');

/**
 * Write side of the `motion_events` table (spec 20). Driven by the internal
 * Motion daemon hook endpoints (`/motion/event-start|event-end|snapshot`).
 * Kept separate from the read-only `MediaRepositoryPort`; the same adapter
 * may implement both.
 */
export interface MediaWriterPort {
  /** Open a new event row when motion starts. Returns the created event. */
  createEvent(cameraId: string | null, startedAt: Date): Promise<MotionEvent>;
  /**
   * Close the most recent still-open (no `endedAt`) event for a camera,
   * recording its end time and video path. Returns the updated event, or
   * `null` when no open event matches.
   */
  closeLatestOpenEvent(
    cameraId: string | null,
    endedAt: Date,
    videoPath: string,
  ): Promise<MotionEvent | null>;
  /**
   * Attach a snapshot path to the most recent still-open event. The Motion
   * `on_picture_save` hook passes only a file path, so there is no camera to
   * disambiguate. Returns the updated event, or `null` when none is open.
   */
  setSnapshotForLatestOpenEvent(snapshotPath: string): Promise<MotionEvent | null>;
  /**
   * Mark an event as uploaded to Drive, recording its remote path (spec 21).
   * Sets `uploadedToGdrive = true` and `gdriveFileId = remotePath`.
   */
  markUploaded(id: number, remotePath: string): Promise<void>;
  /** Mark an event's local files as deleted (`localDeleted = true`, spec 21). */
  markLocalDeleted(id: number): Promise<void>;
  /**
   * Clear the Drive reference for events older than `cutoff` whose remote copy
   * was pruned (`gdriveFileId = null`). Returns the number of rows updated.
   */
  clearGdriveForEventsOlderThan(cutoff: Date): Promise<number>;
}
