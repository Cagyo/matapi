export const UPDATE_DISCOVERY_OPTIONS = Symbol("UPDATE_DISCOVERY_OPTIONS");

export interface UpdateDiscoveryOptions {
  pollIntervalMs: number;
  startupJitterMaxMs: number;
}
