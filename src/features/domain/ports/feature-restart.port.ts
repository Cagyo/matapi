import type { RestartScope } from '../manageable-feature';

export const FEATURE_RESTART = Symbol('FEATURE_RESTART');

/** Restarts one fixed feature runtime scope. */
export interface FeatureRestartPort {
  dispatch(scope: RestartScope): Promise<void>;
}
