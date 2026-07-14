import { isValidPpm } from './co2';
import { Sensor } from './sensor';

export type SensorStateLevel = 'unknown' | 'normal' | 'warning' | 'critical';

export interface ClassifiedSensorState {
  sensor: Sensor;
  level: SensorStateLevel;
  active: boolean | null;
}

export function normalizedSensorName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export function classifySensorState(sensor: Sensor): ClassifiedSensorState {
  const lastValue = sensor.lastValue;
  if (lastValue === null) return classified(sensor, 'unknown', null);

  if (sensor.type === 'digital') return classifyDigital(sensor);
  if (sensor.type === 'uart') return classifyUart(sensor, lastValue);
  return classified(sensor, 'normal', null);
}

export function hasValidUartThresholds(sensor: Sensor): boolean {
  return sensor.type === 'uart' && uartThresholds(sensor.config) !== null;
}

function classifyDigital(sensor: Sensor): ClassifiedSensorState {
  if (sensor.lastValue === 'true' || sensor.lastValue === '1') {
    const level = sensor.severity === 'warning' || sensor.severity === 'critical'
      ? sensor.severity
      : 'normal';
    return classified(sensor, level, true);
  }
  if (sensor.lastValue === 'false' || sensor.lastValue === '0') {
    return classified(sensor, 'normal', false);
  }
  return classified(sensor, 'unknown', null);
}

function classifyUart(sensor: Sensor, lastValue: string): ClassifiedSensorState {
  const ppm = decimalPpm(lastValue);
  if (ppm === null) return classified(sensor, 'unknown', null);

  const thresholds = uartThresholds(sensor.config);
  if (thresholds === null) return classified(sensor, 'normal', null);
  if (ppm >= thresholds.critical) return classified(sensor, 'critical', null);
  if (ppm >= thresholds.warning) return classified(sensor, 'warning', null);
  return classified(sensor, 'normal', null);
}

function classified(
  sensor: Sensor,
  level: SensorStateLevel,
  active: boolean | null,
): ClassifiedSensorState {
  return { sensor, level, active };
}

function decimalPpm(value: string): number | null {
  if (value.trim() === '') return null;
  const ppm = Number(value);
  return isValidPpm(ppm) ? ppm : null;
}

function uartThresholds(
  config: Record<string, unknown>,
): { warning: number; critical: number } | null {
  const raw = config.thresholds;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { warning, critical } = raw as Record<string, unknown>;
  if (
    typeof warning !== 'number' ||
    typeof critical !== 'number' ||
    !Number.isFinite(warning) ||
    !Number.isFinite(critical) ||
    warning <= 0 ||
    warning >= critical
  ) {
    return null;
  }
  return { warning, critical };
}
