export class EventNotFoundError extends Error {
  readonly code = 'EVENT_NOT_FOUND' as const;
  constructor(readonly eventId: number) {
    super(`Motion event #${eventId} not found`);
    this.name = 'EventNotFoundError';
  }
}
