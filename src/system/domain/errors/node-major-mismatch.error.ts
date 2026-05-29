export class NodeMajorMismatchError extends Error {
  readonly code = 'NODE_MAJOR_MISMATCH' as const;
  constructor(
    readonly current: string,
    readonly desired: string,
  ) {
    super(`Node major version mismatch (${current} → ${desired})`);
    this.name = 'NodeMajorMismatchError';
  }
}
