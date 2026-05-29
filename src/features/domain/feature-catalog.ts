/**
 * The fixed catalogue of toggleable features (spec 17). The `features` table
 * stores per-deployment `enabled` / `installed` state keyed by these names;
 * this constant is the source of truth for which names are valid and the
 * human-readable description shown by `/feature list`.
 */
export const FEATURE_CATALOG = [
  { name: 'digital', description: 'GPIO sensors' },
  { name: 'uart', description: 'CO2 serial sensor' },
  { name: 'zigbee', description: 'Zigbee2MQTT gateway' },
  { name: 'motion', description: 'Motion camera' },
  { name: 'neobox', description: 'Neobox intercom' },
  { name: '4g', description: '4G failover' },
] as const;

export type FeatureName = (typeof FEATURE_CATALOG)[number]['name'];

/** Narrow an arbitrary string to a known catalogue feature name. */
export function isKnownFeature(name: string): name is FeatureName {
  return FEATURE_CATALOG.some((entry) => entry.name === name);
}

/** Look up the catalogue description for a known feature name. */
export function featureDescription(name: FeatureName): string {
  return FEATURE_CATALOG.find((entry) => entry.name === name)!.description;
}
