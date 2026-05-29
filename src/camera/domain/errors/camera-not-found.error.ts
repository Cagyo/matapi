export class CameraNotFoundError extends Error {
  readonly code = 'CAMERA_NOT_FOUND' as const;
  constructor(readonly cameraName: string) {
    super(`Camera '${cameraName}' not found`);
    this.name = 'CameraNotFoundError';
  }
}
