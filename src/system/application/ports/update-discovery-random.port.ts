export const UPDATE_DISCOVERY_RANDOM = Symbol("UPDATE_DISCOVERY_RANDOM");

export interface UpdateDiscoveryRandomPort {
  /** Returns a finite value in the inclusive range [0, 1]. */
  next(): number;
}
