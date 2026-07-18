export const UPDATE_DISCOVERY_CLOCK = Symbol("UPDATE_DISCOVERY_CLOCK");

export interface UpdateDiscoveryClockPort {
  now(): Date;
}
