import type { FeatureClockPort } from '../domain/ports/feature-clock.port';

/** Process wall-clock adapter kept inside the Feature bounded context. */
export class SystemFeatureClockAdapter implements FeatureClockPort {
  now(): Date {
    return new Date();
  }
}
