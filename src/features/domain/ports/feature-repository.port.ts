import { Feature } from '../feature.entity';

export const FEATURE_REPOSITORY = Symbol('FEATURE_REPOSITORY');

/**
 * Mutating access to the `features` table (spec 17 — `/feature enable|disable`).
 * Read-only projections for `/export_config` go through `FeatureQueryPort`;
 * this port is reserved for the toggle write path.
 */
export interface FeatureRepositoryPort {
  /** A single feature row, or `null` when no row exists for the name. */
  findByName(name: string): Promise<Feature | null>;

  /**
   * Set the `enabled` flag on an existing feature row and return the updated
   * row. Rows are seeded at install time; this never creates a row.
   */
  setEnabled(name: string, enabled: boolean): Promise<Feature>;
}
