export class CameraConfigInvalidError extends Error {
  readonly code = 'CAMERA_CONFIG_INVALID' as const;
  constructor(readonly reason: string) {
    super(`Camera sensor config invalid: ${reason}`);
    this.name = 'CameraConfigInvalidError';
  }
}
