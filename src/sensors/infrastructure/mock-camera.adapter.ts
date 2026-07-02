import { Injectable, Logger } from '@nestjs/common';
import { SensorDriverPort } from '../domain/ports/sensor-driver.port';
import { SimulatableSensorPort } from '../domain/ports/simulatable-sensor.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';

@Injectable()
export class MockCameraAdapter implements SensorDriverPort, SimulatableSensorPort {
  private readonly logger = new Logger(MockCameraAdapter.name);
  private config?: SensorConfig;
  private currentPath = '';
  private lastTimestamp = new Date(0);
  private listener?: (event: SensorEvent) => void;

  async init(config: SensorConfig): Promise<void> {
    this.config = config;
    this.logger.log(`Mock Camera sensor "${config.name}" initialized`);
  }

  async destroy(): Promise<void> {
    this.listener = undefined;
    this.config = undefined;
  }

  getState(): SensorReading {
    return { value: this.currentPath, timestamp: this.lastTimestamp, raw: { path: this.currentPath } };
  }

  onEvent(callback: (event: SensorEvent) => void): void {
    this.listener = callback;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async captureSnapshot(): Promise<string | null> {
    const path = `/tmp/mock_camera_snapshot_${Date.now()}.jpg`;
    this.simulateChange(path);
    return path;
  }

  simulateChange(path: string): void {
    if (!this.config) return;
    const oldValue = this.currentPath;
    this.currentPath = path;
    this.lastTimestamp = new Date();
    this.listener?.({
      sensorId: this.config.id,
      type: 'state_change',
      oldValue,
      newValue: path,
      timestamp: this.lastTimestamp,
    });
  }

  simulate(value: number): void {
    this.simulateChange(`/tmp/mock_camera_snapshot_${value}.jpg`);
  }
}
