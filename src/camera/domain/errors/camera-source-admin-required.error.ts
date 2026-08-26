export class CameraSourceAdminRequiredError extends Error {
  readonly code = 'CAMERA_SOURCE_ADMIN_REQUIRED' as const;

  constructor() {
    super('Camera source mutations require an administrator');
    this.name = 'CameraSourceAdminRequiredError';
  }
}
