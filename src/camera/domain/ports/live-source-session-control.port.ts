import type { LiveStreamSource } from '../live-stream.entity';

export const LIVE_SOURCE_SESSION_CONTROL = Symbol('LIVE_SOURCE_SESSION_CONTROL');

export interface LiveSourceSessionControlPort {
  /**
   * Stops the active, pending and queued-replacement live-stream work owned by
   * one camera. Other cameras keep streaming. Safe to call for a camera that
   * has no session at all, and safe to call twice.
   */
  stopCamera(cameraId: string): Promise<void>;

  /** Stops every live-stream session of one source kind; other kinds continue. */
  stopSourceKind(kind: LiveStreamSource['kind']): Promise<void>;
}
