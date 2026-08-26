/**
 * The stored source moved between the checks the caller made and the
 * compare-and-swap it attempted: another mutation advanced the revision, an
 * attach won the race, or the camera itself is gone. The caller re-reads and
 * decides again; nothing about the stored source is echoed back.
 */
export class LiveSourceStateChangedError extends Error {
  readonly code = 'LIVE_SOURCE_STATE_CHANGED' as const;

  constructor() {
    super('The stored camera source changed before this edit was applied');
    this.name = 'LiveSourceStateChangedError';
  }
}
