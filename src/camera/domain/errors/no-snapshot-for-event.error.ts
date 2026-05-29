export class NoSnapshotForEventError extends Error {
  readonly code = 'NO_SNAPSHOT_FOR_EVENT' as const;
  constructor(readonly eventId: number) {
    super(`No snapshot available for event #${eventId}`);
    this.name = 'NoSnapshotForEventError';
  }
}
