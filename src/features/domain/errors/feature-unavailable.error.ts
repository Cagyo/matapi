import type { FeatureStatus } from '../feature-status';
import type { ManageableFeatureName } from '../manageable-feature';

export class FeatureUnavailableError extends Error {
  readonly code = 'FEATURE_UNAVAILABLE' as const;

  constructor(
    readonly feature: ManageableFeatureName,
    readonly state: FeatureStatus['display'],
  ) {
    super('Feature is unavailable for this operation');
    this.name = 'FeatureUnavailableError';
  }
}
