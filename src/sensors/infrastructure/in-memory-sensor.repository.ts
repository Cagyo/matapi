import {
  NewSensor,
  SensorPatch,
  SensorRepositoryPort,
} from '../domain/ports/sensor-repository.port';
import { Sensor } from '../domain/sensor';

interface StoredSensorState {
  lastValue: string | null;
  lastValueAt: Date | null;
}

interface ArchivedRow {
  id: string;
  name: string;
  archivedAt: Date;
}

/**
 * In-memory `SensorRepositoryPort` for use-case tests. Seed enabled sensors via
 * the constructor; calls to `updateState` mutate the stored snapshot.
 */
export class InMemorySensorRepository implements SensorRepositoryPort {
  private readonly states = new Map<string, StoredSensorState>();
  private readonly archived: ArchivedRow[] = [];

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

  async findById(id: string): Promise<Sensor | null> {
    return this.sensors.find((s) => s.id === id) ?? null;
  }

  async findByName(name: string): Promise<Sensor | null> {
    return this.sensors.find((s) => s.name === name) ?? null;
  }

  async findActivePinOwner(pin: number): Promise<Sensor | null> {
    return (
      this.sensors.find(
        (s) =>
          s.enabled &&
          s.type === 'digital' &&
          typeof s.config?.pin === 'number' &&
          s.config.pin === pin,
      ) ?? null
    );
  }

  async create(sensor: NewSensor): Promise<Sensor> {
    const persisted: Sensor = {
      id: sensor.id,
      name: sensor.name,
      type: sensor.type,
      config: sensor.config,
      enabled: true,
      debounceMs: sensor.debounceMs,
      severity: sensor.severity,
      lastValue: null,
      lastValueAt: null,
    };
    this.sensors = [...this.sensors, persisted];
    this.states.set(persisted.id, { lastValue: null, lastValueAt: null });
    return persisted;
  }

  async update(id: string, patch: SensorPatch): Promise<Sensor> {
    const idx = this.sensors.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`update: sensor ${id} not found`);
    const prev = this.sensors[idx];
    const next: Sensor = {
      ...prev,
      name: patch.name ?? prev.name,
      config: patch.config ?? prev.config,
      debounceMs: patch.debounceMs ?? prev.debounceMs,
      severity: patch.severity ?? prev.severity,
    };
    this.sensors = [...this.sensors.slice(0, idx), next, ...this.sensors.slice(idx + 1)];
    return next;
  }

  async archive(id: string, archivedAt: Date): Promise<void> {
    const idx = this.sensors.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`archive: sensor ${id} not found`);
    const row = this.sensors[idx];
    this.archived.push({ id: row.id, name: row.name, archivedAt });
    this.sensors = [...this.sensors.slice(0, idx), ...this.sensors.slice(idx + 1)];
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

  listArchived(): ReadonlyArray<ArchivedRow> {
    return this.archived;
  }
}
