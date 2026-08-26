/**
 * Another camera already answers to the canonical key of the attempted name.
 * The name is deliberately absent: the message reaches Telegram, and echoing a
 * name back would confirm a camera the actor may not be allowed to know about.
 */
export class CameraNameTakenError extends Error {
  readonly code = 'CAMERA_NAME_TAKEN' as const;

  constructor() {
    super('Another camera already uses that name');
    this.name = 'CameraNameTakenError';
  }
}
