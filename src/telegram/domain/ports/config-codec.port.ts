import { ConfigSnapshot } from '../config-snapshot';

export const CONFIG_CODEC = Symbol('CONFIG_CODEC');

/**
 * Serializes/parses the import-export config document (spec 16). Keeps the
 * concrete wire format (YAML) out of the application layer.
 */
export interface ConfigCodecPort {
  /** Render a snapshot to the on-disk document format. */
  serialize(snapshot: ConfigSnapshot): string;
  /** Parse a raw document into an untyped structure for validation. */
  parse(text: string): unknown;
}
