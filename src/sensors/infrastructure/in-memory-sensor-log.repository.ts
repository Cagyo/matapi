import {
  SensorLogEntry,
  SensorLogQuery,
  SensorLogRepositoryPort,
} from '../domain/ports/sensor-log-repository.port';

/** Test/dev `SensorLogRepositoryPort` that accumulates entries in memory. */
export class InMemorySensorLogRepository implements SensorLogRepositoryPort {
  readonly entries: SensorLogEntry[] = [];

  async appendBatch(entries: SensorLogEntry[]): Promise<void> {
    this.entries.push(...entries);
  }

  async findRecent(
    sensorId: string,
    query: SensorLogQuery,
  ): Promise<SensorLogEntry[]> {
    return this.entries
      .filter((e) => e.sensorId === sensorId)
      .filter((e) => (query.since ? e.timestamp >= query.since : true))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, query.limit);
  }
}
