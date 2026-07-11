import {
  ArchivedSensor,
  SensorLookup,
  SensorQueryPort,
} from '../domain/ports/sensor-query.port';
import { Sensor } from '../domain/sensor';

/** In-memory `SensorQueryPort` for dev mode and use-case tests. */
export class InMemorySensorQuery implements SensorQueryPort {
  constructor(
    private sensors: Sensor[] = [],
    private archived: ArchivedSensor[] = [],
  ) {}

  async listEnabled(): Promise<Sensor[]> {
    return this.sensors.filter((s) => s.enabled);
  }

  async findById(id: string): Promise<Sensor | null> {
    const found = this.sensors.find((s) => s.id === id && s.enabled);
    return found ?? null;
  }

  async findByIdIncludingArchived(id: string): Promise<SensorLookup | null> {
    const active = this.sensors.find((sensor) => sensor.id === id);
    if (active) return { kind: 'active', sensor: active };
    const archived = this.archived.find((sensor) => sensor.id === id);
    return archived ? { kind: 'archived', sensor: archived } : null;
  }

  async findByName(name: string): Promise<SensorLookup | null> {
    const active = this.sensors.find((s) => s.name === name);
    if (active) return { kind: 'active', sensor: active };
    const archived = this.archived.find((s) => s.name === name);
    if (archived) return { kind: 'archived', sensor: archived };
    return null;
  }

  setSensors(next: Sensor[]): void {
    this.sensors = next;
  }

  setArchived(next: ArchivedSensor[]): void {
    this.archived = next;
  }
}
