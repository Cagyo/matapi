export class FeatureAlreadyEnabledError extends Error {
  readonly code = 'FEATURE_ALREADY_ENABLED' as const;
  constructor(readonly featureName: string) {
    super(`Feature '${featureName}' is already enabled`);
    this.name = 'FeatureAlreadyEnabledError';
  }
}
