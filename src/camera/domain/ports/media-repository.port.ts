import { Camera } from '../camera.entity';
import { MotionEvent } from '../motion-event.entity';

export const MEDIA_REPOSITORY = Symbol('MEDIA_REPOSITORY');

/** Aggregate upload counters for `/gdrive status` (spec 15). */
export interface UploadStats {
  /** Events whose video has not yet reached Drive. */
  pending: number;
  /** Most recent successful upload, or `null` if none. */
  lastUploadAt: Date | null;
}

export interface BrowseMotionEvent extends MotionEvent {
  /** Display name from `cameras.name`, or `null` when the camera row is gone. */
  cameraName: string | null;
}

/**
 * Read model over `cameras` and `motion_events` (specs 14, 15). All times
 * are JS `Date`; the adapter handles the epoch <-> Date conversion.
 */
export interface MediaRepositoryPort {
  listCameras(): Promise<Camera[]>;
  /**
   * Case-insensitive name lookup; `null` when absent. Results may be disabled,
   * so callers that expose a camera externally must check `camera.enabled`.
   */
  findCameraByName(name: string): Promise<Camera | null>;
  findEventById(id: number): Promise<MotionEvent | null>;
  /** Events whose `startedAt` falls within the local-time day of `day`. */
  listEventsOnDay(day: Date): Promise<MotionEvent[]>;
  /**
   * Newest motion events first. Callers pass `visibleLimit + 1` when they need
   * to detect whether more rows exist without a count query.
   */
  listLatestEvents(limit: number): Promise<BrowseMotionEvent[]>;
  /**
   * Events whose `startedAt` is in `[start, end)`, newest first. Callers pass
   * `visibleLimit + 1` when they need `hasMore`.
   */
  listEventsStartedBetween(start: Date, end: Date, limit: number): Promise<BrowseMotionEvent[]>;
  countEventsOnDay(day: Date): Promise<number>;
  lastEvent(): Promise<MotionEvent | null>;
  uploadStats(): Promise<UploadStats>;
  /**
   * Closed events whose video is recorded but not yet on Drive, oldest first
   * (`uploadedToGdrive = false`, `videoPath != null`, `localDeleted = false`,
   * `endedAt != null`). Drives the upload loop (spec 21).
   */
  findPendingUploads(): Promise<MotionEvent[]>;
  /**
   * Events safe to delete locally — already on Drive and not yet deleted
   * (`uploadedToGdrive = true`, `localDeleted = false`), oldest first. Drives
   * the local cleanup loop (spec 21).
   */
  findUploadedNotDeleted(): Promise<MotionEvent[]>;
  /**
   * Every non-null video/snapshot path the DB references, regardless of
   * upload/delete flags. Used by the orphan sweep: a local file NOT in this
   * list belongs to no event and is safe to age out.
   */
  listAllMediaPaths(): Promise<string[]>;
}
