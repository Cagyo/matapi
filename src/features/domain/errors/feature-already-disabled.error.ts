export class FeatureAlreadyDisabledError extends Error {
  readonly code = 'FEATURE_ALREADY_DISABLED' as const;
  constructor(readonly featureName: string) {
    super(`Feature '${featureName}' is already disabled`);
    this.name = 'FeatureAlreadyDisabledError';
  }
}
