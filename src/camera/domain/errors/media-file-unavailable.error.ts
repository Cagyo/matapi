export class MediaFileUnavailableError extends Error {
  readonly code = 'MEDIA_FILE_UNAVAILABLE' as const;
  constructor(readonly eventId: number) {
    super(`Media file for event #${eventId} is no longer available`);
    this.name = 'MediaFileUnavailableError';
  }
}
