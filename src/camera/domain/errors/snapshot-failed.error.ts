export class SnapshotFailedError extends Error {
  readonly code = 'SNAPSHOT_FAILED' as const;
  constructor(readonly cameraName: string, readonly reason: string) {
    super(`Failed to capture snapshot for '${cameraName}': ${reason}`);
    this.name = 'SnapshotFailedError';
  }
}
