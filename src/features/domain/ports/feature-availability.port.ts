import type { FeatureStatus } from '../feature-status';
import type { ManageableFeatureName } from '../manageable-feature';

export const FEATURE_AVAILABILITY = Symbol('FEATURE_AVAILABILITY');

/** Published, boot-gated readiness projection for feature consumers. */
export interface FeatureAvailabilityPort {
  awaitInitialVerification(): Promise<void>;
  inspect(name: ManageableFeatureName): Promise<FeatureStatus>;
  requireReady(name: ManageableFeatureName): Promise<void>;
}
