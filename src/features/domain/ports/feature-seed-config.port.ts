import type { ManageableFeatureName } from '../manageable-feature';

export const FEATURE_SEED_CONFIG = Symbol('FEATURE_SEED_CONFIG');

/** Read-only, verified first-install selection supplied by an interface adapter. */
export interface FeatureSeedConfigPort {
  /** Returns null when the first-install config is absent or cannot be trusted. */
  loadEnabled(): Promise<readonly ManageableFeatureName[] | null>;
}
