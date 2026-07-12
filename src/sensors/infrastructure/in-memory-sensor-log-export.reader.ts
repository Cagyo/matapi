import { MalformedSensorLogTimestampError } from '../domain/errors/malformed-sensor-log-timestamp.error';
import { SensorLogExportRowTooLargeError } from '../domain/errors/sensor-log-export-row-too-large.error';
import {
  SensorLogExportReaderPort,
  SensorLogExportRow,
} from '../domain/ports/sensor-log-export-reader.port';

export interface InMemorySensorLogExportEntry extends SensorLogExportRow {
  readonly sensorId: string;
}

/** In-memory `SensorLogExportReaderPort` for use-case tests and development. */
export class InMemorySensorLogExportReader implements SensorLogExportReaderPort {
  constructor(private readonly entries: readonly InMemorySensorLogExportEntry[] = []) {}

  withRows(
    sensorId: string,
    options: { limit: number; maxMessageBytes: number },
    consume: (rows: Iterable<SensorLogExportRow>) => void,
  ): void {
    const selected = this.entries
      .filter((entry) => entry.sensorId === sensorId)
      .slice()
      .sort(compareNewestFirst)
      .slice(0, options.limit);
    const maxMessageBytes = selected.reduce(
      (maximum, entry) => Math.max(maximum, Buffer.byteLength(entry.message, 'utf8')),
      0,
    );

    if (maxMessageBytes > options.maxMessageBytes) {
      throw new SensorLogExportRowTooLargeError(maxMessageBytes, options.maxMessageBytes);
    }
    if (selected.some((entry) => entry.timestamp === null)) {
      throw new MalformedSensorLogTimestampError(sensorId);
    }

    consume(selected.slice().sort(compareOldestFirst));
  }
}

function compareNewestFirst(left: InMemorySensorLogExportEntry, right: InMemorySensorLogExportEntry): number {
  if (left.timestamp === null) return right.timestamp === null ? right.id - left.id : 1;
  if (right.timestamp === null) return -1;
  return right.timestamp.getTime() - left.timestamp.getTime() || right.id - left.id;
}

function compareOldestFirst(left: InMemorySensorLogExportEntry, right: InMemorySensorLogExportEntry): number {
  if (left.timestamp === null) return right.timestamp === null ? left.id - right.id : -1;
  if (right.timestamp === null) return 1;
  return left.timestamp.getTime() - right.timestamp.getTime() || left.id - right.id;
}
