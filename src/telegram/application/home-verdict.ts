import { ClassifiedSensorState } from '../../sensors/domain/sensor-state-classifier';
import {
  HOME_HEALTH_FRESH_MS,
  HomeHealthSnapshot,
} from '../domain/home-health-snapshot';

export type HomeVerdict = 'attention' | 'unavailable' | 'normal';

export interface HomeVerdictInput {
  sensors: readonly ClassifiedSensorState[];
  health: HomeHealthSnapshot | null;
  now: Date;
}

/**
 * Determines whether the cached Home data is actionable without observing or
 * mutating anything. Attention deliberately takes priority over cache health:
 * an active alarm must never be hidden behind stale monitoring data.
 */
export function deriveHomeVerdict(input: HomeVerdictInput): HomeVerdict {
  if (input.sensors.some(({ level }) => level === 'warning' || level === 'critical')) {
    return 'attention';
  }

  const { health, sensors, now } = input;
  if (
    sensors.length === 0 ||
    sensors.some(({ level }) => level === 'unknown') ||
    health === null ||
    now.getTime() - health.completedAt.getTime() >= HOME_HEALTH_FRESH_MS ||
    !sameIds(sensors.map(({ sensor }) => sensor.id), health.enabledSensorIds) ||
    !sameIds(sensors.map(({ sensor }) => sensor.id), health.onlineSensorIds) ||
    health.missingSensorIds.length > 0 ||
    health.failedSensorIds.length > 0 ||
    health.timedOutSensorIds.length > 0 ||
    health.offlineSensorIds.length > 0
  ) {
    return 'unavailable';
  }

  return 'normal';
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = sortedUnique(left);
  const normalizedRight = sortedUnique(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every(
    (id, index) => id === normalizedRight[index],
  );
}

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}
