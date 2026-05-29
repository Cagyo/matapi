export const MOTION_ALERT = Symbol('MOTION_ALERT');

/**
 * Outbound notification when motion starts (spec 20). Owned by the camera
 * context; the real adapter delegates to the events notification pipeline,
 * which applies mute / quiet-hours filtering and delivers the photo.
 */
export interface MotionAlertPort {
  /**
   * @param cameraName human-readable camera name for the caption
   * @param at         event start time (injected; not `new Date()` downstream)
   * @param photo      a snapshot JPEG, or `null` when none could be grabbed
   */
  motionStarted(cameraName: string, at: Date, photo: Buffer | null): Promise<void>;
}
