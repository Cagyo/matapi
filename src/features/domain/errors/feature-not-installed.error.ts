export class FeatureNotInstalledError extends Error {
  readonly code = 'FEATURE_NOT_INSTALLED' as const;
  constructor(readonly featureName: string) {
    super(`Feature '${featureName}' system dependencies are not installed`);
    this.name = 'FeatureNotInstalledError';
  }
}
