export const CAMERA_ID_GENERATOR = Symbol('CAMERA_ID_GENERATOR');

/**
 * Mints the opaque identifier a new RTSP camera is stored under. Kept as a port
 * so a caller that hits `CameraIdCollisionError` can retry with a fresh value,
 * and so tests can inject a deterministic sequence.
 */
export interface CameraIdGeneratorPort {
  /** Carries no caller-supplied meaning — never derived from a display name. */
  generate(): string;
}
