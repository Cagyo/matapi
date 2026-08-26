/**
 * A generated camera identifier is already stored. Only the `cameras` primary
 * key raises this; the caller answers by minting another identifier, so the
 * colliding value is deliberately absent from the message.
 */
export class CameraIdCollisionError extends Error {
  readonly code = 'CAMERA_ID_COLLISION' as const;

  constructor() {
    super('Generated camera identifier is already in use');
    this.name = 'CameraIdCollisionError';
  }
}
