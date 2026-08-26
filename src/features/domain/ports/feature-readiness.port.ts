import type { ManageableFeatureName, RestartScope } from '../manageable-feature';

export const FEATURE_READINESS = Symbol('FEATURE_READINESS');

/**
 * Why an application-level check refused, at the granularity recovery acts on.
 *
 * `runtime-group-incomplete` is the one reason a restart can fix by itself: the
 * process must be re-executed to pick up a group the installer just granted.
 * The other two are terminal until an operator reinstalls.
 */
export type FeatureReadinessFailureReason =
  | 'policy-stale'
  | 'runtime-group-incomplete'
  | 'runtime-invalid';

export type FeatureReadinessResult =
  | { ready: true; restartScope: RestartScope; policyDigest?: string }
  | {
      ready: false;
      failureCode: 'application-verification-failed';
      reason: FeatureReadinessFailureReason;
    };

/** Application-visible checks for dependencies installed by a feature routine. */
export interface FeatureReadinessPort {
  verify(name: ManageableFeatureName): Promise<FeatureReadinessResult>;
}
