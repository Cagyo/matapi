/** Initial boot-time verification gate for feature availability. */
export const FEATURE_READINESS_BARRIER = Symbol('FEATURE_READINESS_BARRIER');

export interface FeatureReadinessBarrierPort {
  awaitInitialVerification(): Promise<void>;
}
