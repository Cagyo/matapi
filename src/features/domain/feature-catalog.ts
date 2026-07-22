/**
 * The fixed catalogue of toggleable features (spec 17). The `features` table
 * stores per-deployment `enabled` / `installed` state keyed by these names;
 * this constant is the source of truth for which names are valid and the
 * human-readable description shown by `/feature list`.
 */
import catalog from '../../../config/feature-catalog.json';
import {
  isManageableFeature,
  type ManageableFeatureName,
} from './manageable-feature';

export interface FeatureCatalogEntry {
  name: ManageableFeatureName;
  descriptionKey: string;
  defaultEnabled?: boolean;
}

export type FeatureDescriptionResolver = (key: string) => string;

export const FEATURE_CATALOG = validateFeatureCatalog(catalog);

export type FeatureName = ManageableFeatureName;

/** Narrow an arbitrary string to a known catalogue feature name. */
export function isKnownFeature(name: string): name is FeatureName {
  return FEATURE_CATALOG.some((entry) => entry.name === name);
}

/** Resolve the catalogue description for a known feature name. */
export function featureDescription(
  name: FeatureName,
  resolveDescription: FeatureDescriptionResolver,
): string {
  const entry = FEATURE_CATALOG.find((feature) => feature.name === name)!;
  return resolveDescription(entry.descriptionKey);
}

function validateFeatureCatalog(value: unknown): readonly FeatureCatalogEntry[] {
  if (!Array.isArray(value)) throw new RangeError('Invalid feature catalog');

  const seen = new Set<ManageableFeatureName>();
  const entries: FeatureCatalogEntry[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !isManageableFeature(entry.name) ||
      typeof entry.descriptionKey !== 'string' ||
      entry.descriptionKey.trim() === '' ||
      (entry.defaultEnabled !== undefined &&
        typeof entry.defaultEnabled !== 'boolean') ||
      seen.has(entry.name)
    ) {
      throw new RangeError('Invalid feature catalog');
    }
    seen.add(entry.name);
    entries.push({
      name: entry.name,
      descriptionKey: entry.descriptionKey,
      ...(entry.defaultEnabled === undefined
        ? {}
        : { defaultEnabled: entry.defaultEnabled }),
    });
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
