/**
 * A catalogue feature merged with its persisted state, as rendered by
 * `/feature list` (spec 17). Features absent from the `features` table are
 * reported as `enabled: false, installed: false`.
 */
export interface FeatureStatus {
  name: string;
  description: string;
  enabled: boolean;
  installed: boolean;
}
