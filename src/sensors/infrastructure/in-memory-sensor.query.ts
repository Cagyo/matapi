import {
  ArchivedSensor,
  SensorHistoryPage,
  SensorHistoryTarget,
  SensorLookup,
  SensorQueryPort,
} from '../domain/ports/sensor-query.port';
import { buildSensorDashboardPage, SensorDashboardPage } from '../domain/sensor-dashboard-page';
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

  async listDashboardPage(input: { page: number; pageSize: 8 }): Promise<SensorDashboardPage> {
    return buildSensorDashboardPage(await this.listEnabled(), input);
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

  async listHistoryTargets(input: { page: number; pageSize: number }): Promise<SensorHistoryPage> {
    const targets = [
      ...this.sensors.map(
        (sensor): SensorHistoryTarget => ({
          id: sensor.id,
          name: sensor.name,
          type: sensor.type,
          enabled: sensor.enabled,
          state: 'current',
          archivedAt: null,
        }),
      ),
      ...this.archived.map(
        (sensor): SensorHistoryTarget => ({
          id: sensor.id,
          name: sensor.name,
          type: sensor.type,
          enabled: false,
          state: 'archived',
          archivedAt: sensor.archivedAt,
        }),
      ),
    ].sort(compareHistoryTargets);
    const pageCount = Math.ceil(targets.length / input.pageSize);

    if (pageCount === 0) return { targets: [], page: 0, pageCount: 0 };

    const page = Math.min(input.page, pageCount - 1);
    const start = page * input.pageSize;
    return {
      targets: targets.slice(start, start + input.pageSize),
      page,
      pageCount,
    };
  }

  setSensors(next: Sensor[]): void {
    this.sensors = next;
  }

  setArchived(next: ArchivedSensor[]): void {
    this.archived = next;
  }
}

function compareHistoryTargets(left: SensorHistoryTarget, right: SensorHistoryTarget): number {
  if (left.state !== right.state) return left.state === 'current' ? -1 : 1;

  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}
