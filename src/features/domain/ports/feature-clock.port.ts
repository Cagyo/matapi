export const FEATURE_CLOCK = Symbol('FEATURE_CLOCK');

/** Local clock seam so the feature context does not depend on Events or System. */
export interface FeatureClockPort {
  now(): Date;
}
