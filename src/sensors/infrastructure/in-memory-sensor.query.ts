import { SensorQueryPort } from '../domain/ports/sensor-query.port';
import { Sensor } from '../domain/sensor';

/** In-memory `SensorQueryPort` for dev mode and use-case tests. */
export class InMemorySensorQuery implements SensorQueryPort {
  constructor(private sensors: Sensor[] = []) {}

  async listEnabled(): Promise<Sensor[]> {
    return this.sensors.filter((s) => s.enabled);
  }

  async findById(id: string): Promise<Sensor | null> {
    const found = this.sensors.find((s) => s.id === id && s.enabled);
    return found ?? null;
  }

  setSensors(next: Sensor[]): void {
    this.sensors = next;
  }
}
