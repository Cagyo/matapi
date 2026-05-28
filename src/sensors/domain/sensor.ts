export type SensorType = 'digital' | 'uart' | 'mqtt' | 'camera';
export type SensorSeverity = 'info' | 'warning' | 'critical';

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
