import type { ManageableFeatureName } from '../manageable-feature';

export class FeatureStateChangedError extends Error {
  readonly code = 'FEATURE_STATE_CHANGED' as const;

  constructor(readonly feature: ManageableFeatureName) {
    super('Feature state changed before confirmation');
    this.name = 'FeatureStateChangedError';
  }
}
