export type SensorType = 'digital' | 'uart' | 'mqtt' | 'camera';
export type SensorSeverity = 'info' | 'warning' | 'critical';

export interface SensorConfig {
  id: string;
  name: string;
  type: SensorType;
  config: Record<string, any>;
  debounceMs: number;
  severity: SensorSeverity;
}

export interface SensorReading {
  value: string | number | boolean;
  timestamp: Date;
  raw?: any;
}

export interface SensorEvent {
  sensorId: string;
  type: 'state_change' | 'threshold' | 'error';
  oldValue?: any;
  newValue: any;
  timestamp: Date;
}

export interface ISensorDriver {
  init(config: SensorConfig): Promise<void>;
  destroy(): Promise<void>;
  getState(): SensorReading;
  onEvent(callback: (event: SensorEvent) => void): void;
  healthCheck(): Promise<boolean>;
}
