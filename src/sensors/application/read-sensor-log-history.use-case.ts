import { Inject, Injectable } from '@nestjs/common';
import { SensorNotFoundError } from '../domain/errors/sensor-not-found.error';
import {
  SENSOR_LOG_EXPORT_READER,
  SensorLogExportReaderPort,
  SensorLogExportRow,
} from '../domain/ports/sensor-log-export-reader.port';
import {
  SENSOR_QUERY,
  SensorLookup,
  SensorQueryPort,
} from '../domain/ports/sensor-query.port';

export type SensorLogHistoryTarget =
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'id'; readonly id: string };

export interface ReadSensorLogHistoryInput {
  readonly target: SensorLogHistoryTarget;
  readonly limit: number;
  readonly maxMessageBytes: number;
  /** This callback must complete synchronously while the SQLite snapshot is open. */
  readonly consume: (sensor: SensorLookup['sensor'], rows: Iterable<SensorLogExportRow>) => unknown;
}

@Injectable()
export class ReadSensorLogHistoryUseCase {
  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(SENSOR_LOG_EXPORT_READER) private readonly reader: SensorLogExportReaderPort,
  ) {}

  async execute(input: ReadSensorLogHistoryInput): Promise<void> {
    const lookup = await this.resolve(input.target);
    if (!lookup) {
      throw new SensorNotFoundError(
        input.target.kind === 'name' ? input.target.name : input.target.id,
      );
    }

    this.reader.withRows(
      lookup.sensor.id,
      { limit: input.limit, maxMessageBytes: input.maxMessageBytes },
      (rows) => {
        const result = input.consume(lookup.sensor, rows);
        if (isThenable(result)) {
          throw new TypeError('Sensor log history consumers must complete synchronously');
        }
      },
    );
  }

  private resolve(target: SensorLogHistoryTarget): Promise<SensorLookup | null> {
    return target.kind === 'name'
      ? this.sensors.findByName(target.name)
      : this.sensors.findByIdIncludingArchived(target.id);
  }
}

function isThenable(value: unknown): value is { then: unknown } {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}
