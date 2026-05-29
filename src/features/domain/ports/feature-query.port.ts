import { Feature } from '../feature.entity';

export const FEATURE_QUERY = Symbol('FEATURE_QUERY');

/**
 * Read-only projection of the `features` table (specs 16, 17). Used by
 * `/export_config` to snapshot which features are enabled. Mutations (when
 * `/feature` lands) will go through a separate repository port.
 */
export interface FeatureQueryPort {
  /** All features, ordered by name. */
  listAll(): Promise<Feature[]>;
}
