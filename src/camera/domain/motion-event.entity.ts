/** A single motion-detection event (spec 20). Mirrors `motion_events`. */
export interface MotionEvent {
  id: number;
  cameraId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  videoPath: string | null;
  snapshotPath: string | null;
  uploadedToGdrive: boolean;
  gdriveFileId: string | null;
  localDeleted: boolean;
}

/** Duration of an event in seconds, or `null` when it has no end yet. */
export function eventDurationSec(event: MotionEvent): number | null {
  if (!event.startedAt || !event.endedAt) return null;
  const ms = event.endedAt.getTime() - event.startedAt.getTime();
  if (ms < 0) return null;
  return Math.round(ms / 1000);
}
