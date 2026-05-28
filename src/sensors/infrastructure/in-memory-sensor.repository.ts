import { SensorRepositoryPort } from '../domain/ports/sensor-repository.port';
import { Sensor } from '../domain/sensor';

interface StoredSensorState {
  lastValue: string | null;
  lastValueAt: Date | null;
}

/**
 * In-memory `SensorRepositoryPort` for use-case tests. Seed enabled sensors via
 * the constructor; calls to `updateState` mutate the stored snapshot.
 */
export class InMemorySensorRepository implements SensorRepositoryPort {
  private readonly states = new Map<string, StoredSensorState>();

  constructor(private sensors: Sensor[] = []) {
    for (const sensor of sensors) {
      this.states.set(sensor.id, {
        lastValue: sensor.lastValue,
        lastValueAt: sensor.lastValueAt,
      });
    }
  }

  async loadEnabled(): Promise<Sensor[]> {
    return this.sensors
      .filter((s) => s.enabled)
      .map((s) => {
        const state = this.states.get(s.id);
        return { ...s, lastValue: state?.lastValue ?? null, lastValueAt: state?.lastValueAt ?? null };
      });
  }

  async updateState(id: string, value: string, at: Date): Promise<void> {
    this.states.set(id, { lastValue: value, lastValueAt: at });
  }

  /** Replace the seed set; useful for hot-reload-style tests. */
  setSensors(next: Sensor[]): void {
    this.sensors = next;
    for (const sensor of next) {
      if (!this.states.has(sensor.id)) {
        this.states.set(sensor.id, {
          lastValue: sensor.lastValue,
          lastValueAt: sensor.lastValueAt,
        });
      }
    }
  }

  lastValueFor(id: string): StoredSensorState | undefined {
    return this.states.get(id);
  }
}
