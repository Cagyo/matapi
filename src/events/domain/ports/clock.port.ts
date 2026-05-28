export const CLOCK = Symbol('CLOCK');

export interface ClockPort {
  now(): Date;
}