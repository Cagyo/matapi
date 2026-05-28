import {
  SensorLogEntry,
  SensorLogRepositoryPort,
} from '../domain/ports/sensor-log-repository.port';

/** Test/dev `SensorLogRepositoryPort` that accumulates entries in memory. */
export class InMemorySensorLogRepository implements SensorLogRepositoryPort {
  readonly entries: SensorLogEntry[] = [];

  async appendBatch(entries: SensorLogEntry[]): Promise<void> {
    this.entries.push(...entries);
  }
}
