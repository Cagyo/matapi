export class SystemDepsCheckFailedError extends Error {
  readonly code = 'SYSTEM_DEPS_CHECK_FAILED' as const;
  constructor(readonly reason: string) {
    super(`System dependency check failed: ${reason}`);
    this.name = 'SystemDepsCheckFailedError';
  }
}
