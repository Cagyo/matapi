/** A single motion-detection event (spec 20). Mirrors `motion_events`. */
export interface MotionEvent {
  id: number;
  cameraId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  videoPath: string | null;
  snapshotPath: string | null;
  /** Durable archive manifest entry for this completed video, when registered. */
  archiveArtifactId: string | null;
  /** Fresh private link projection; never persisted as a remote path or ID. */
  archiveWebViewLink: string | null;
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
