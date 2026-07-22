import type {
  FeatureAttentionReason,
  ManageableFeatureName,
} from '../manageable-feature';

export class FeatureVerificationError extends Error {
  readonly code = 'FEATURE_VERIFICATION_FAILED' as const;

  constructor(
    readonly feature: ManageableFeatureName,
    readonly reason: FeatureAttentionReason,
  ) {
    super('Feature readiness verification failed');
    this.name = 'FeatureVerificationError';
  }
}
