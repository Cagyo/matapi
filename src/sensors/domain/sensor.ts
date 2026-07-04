export type SensorType = 'digital' | 'uart' | 'mqtt' | 'camera';
export type SensorSeverity = 'info' | 'warning' | 'critical';
export type DigitalStepType = 'contact' | 'leak_hazard' | 'alarm' | 'power' | 'motion' | 'button';

export const DIGITAL_STEP_TYPES: readonly DigitalStepType[] = [
  'contact',
  'leak_hazard',
  'alarm',
  'power',
  'motion',
  'button',
] as const;

export function isDigitalStepType(value: unknown): value is DigitalStepType {
  return typeof value === 'string' && DIGITAL_STEP_TYPES.includes(value as DigitalStepType);
}

/** Runtime config passed to a driver at init time. */
export interface SensorConfig {
  id: string;
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  debounceMs: number;
  severity: SensorSeverity;
}

/** Domain entity — one row of the `sensors` table mapped to the domain. */
export interface Sensor {
  id: string;
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  enabled: boolean;
  debounceMs: number;
  severity: SensorSeverity;
  lastValue: string | null;
  lastValueAt: Date | null;
}
