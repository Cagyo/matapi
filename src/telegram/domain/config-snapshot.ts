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

export interface ConfigSnapshotLiveSource {
  camera_name: string;
  scheme: 'rtsp' | 'rtsps';
  host: string;
  transport: 'auto' | 'tcp' | 'udp';
  tls_mode: 'none' | 'strict';
  profile: 'eco' | 'balanced' | 'quality';
  substream_host?: string | null;
  ready: false;
}

export interface ConfigSnapshot {
  sensors: ConfigSnapshotSensor[];
  cameras: ConfigSnapshotCamera[];
  live_sources: ConfigSnapshotLiveSource[];
  features: ConfigSnapshotFeature[];
}
