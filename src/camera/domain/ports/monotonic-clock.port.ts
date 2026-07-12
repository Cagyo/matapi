export const MONOTONIC_CLOCK = Symbol('MONOTONIC_CLOCK');

/** Returns elapsed monotonic time in milliseconds. */
export interface MonotonicClockPort {
  now(): number;
}
