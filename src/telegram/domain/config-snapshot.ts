/** Structured config snapshot serialized by `/export_config` (spec 16). */
export interface ConfigSnapshotSensor {
  name: string;
  type: string;
  config: Record<string, unknown>;
  debounce_ms: number;
  severity: string;
}

export interface ConfigSnapshotCamera {
  name: string;
  type: string;
  config: Record<string, unknown> | null;
}

export interface ConfigSnapshotFeature {
  name: string;
  enabled: boolean;
}

export interface ConfigSnapshot {
  sensors: ConfigSnapshotSensor[];
  cameras: ConfigSnapshotCamera[];
  features: ConfigSnapshotFeature[];
}
