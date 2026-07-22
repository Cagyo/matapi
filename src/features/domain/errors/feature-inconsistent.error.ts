import type { ManageableFeatureName } from '../manageable-feature';

export class FeatureInconsistentError extends Error {
  readonly code = 'FEATURE_INCONSISTENT' as const;

  constructor(readonly feature: ManageableFeatureName) {
    super('Feature state is inconsistent');
    this.name = 'FeatureInconsistentError';
  }
}
