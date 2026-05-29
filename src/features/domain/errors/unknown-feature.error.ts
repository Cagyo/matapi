export class UnknownFeatureError extends Error {
  readonly code = 'UNKNOWN_FEATURE' as const;
  constructor(readonly featureName: string) {
    super(`Unknown feature '${featureName}'`);
    this.name = 'UnknownFeatureError';
  }
}
