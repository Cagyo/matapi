import type { ManageableFeatureName, RestartScope } from '../manageable-feature';

export const FEATURE_READINESS = Symbol('FEATURE_READINESS');

export type FeatureReadinessResult =
  | { ready: true; restartScope: RestartScope }
  | { ready: false; failureCode: 'application-verification-failed' };

/** Application-visible checks for dependencies installed by a feature routine. */
export interface FeatureReadinessPort {
  verify(name: ManageableFeatureName): Promise<FeatureReadinessResult>;
}
