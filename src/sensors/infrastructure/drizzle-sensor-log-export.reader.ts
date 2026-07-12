import { Inject, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import { SQLITE } from '../../database/database.module';
import { MalformedSensorLogTimestampError } from '../domain/errors/malformed-sensor-log-timestamp.error';
import { SensorLogExportRowTooLargeError } from '../domain/errors/sensor-log-export-row-too-large.error';
import {
  SensorLogExportReaderPort,
  SensorLogExportRow,
} from '../domain/ports/sensor-log-export-reader.port';
import { SensorLogLevel } from '../domain/ports/sensor-log-repository.port';

interface ExportPreflightRow {
  maxMessageBytes: number | null;
  nullTimestampCount: number;
}

interface RawExportRow {
  id: number;
  level: string;
  message: string;
  timestamp: number;
}

const SELECTED_ROWS_CTE = `
  WITH selected_rows AS (
    SELECT id, level, message, timestamp
    FROM sensor_logs
    WHERE sensor_id = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  )
`;

const PREFLIGHT_SQL = `${SELECTED_ROWS_CTE}
  SELECT
    max(length(CAST(message AS BLOB))) AS maxMessageBytes,
    count(*) FILTER (WHERE timestamp IS NULL) AS nullTimestampCount
  FROM selected_rows
`;

const ROWS_SQL = `${SELECTED_ROWS_CTE}
  SELECT id, level, message, timestamp
  FROM selected_rows
  ORDER BY timestamp ASC, id ASC
`;

/** SQLite snapshot reader for bounded oldest-to-newest export streams. */
@Injectable()
export class DrizzleSensorLogExportReader implements SensorLogExportReaderPort {
  private readonly preflight: Database.Statement<[string, number], ExportPreflightRow>;
  private readonly rows: Database.Statement<[string, number], RawExportRow>;
  private readonly withinSnapshot: (
    sensorId: string,
    options: { limit: number; maxMessageBytes: number },
    consume: (rows: Iterable<SensorLogExportRow>) => void,
  ) => void;

  constructor(@Inject(SQLITE) private readonly sqlite: Database.Database) {
    this.preflight = sqlite.prepare(PREFLIGHT_SQL);
    this.rows = sqlite.prepare(ROWS_SQL);
    this.withinSnapshot = sqlite.transaction((sensorId, options, consume) => {
      // SQLite aggregates always return one row, but the driver correctly
      // represents a general `Statement#get` result as optional.
      const preflight = this.preflight.get(sensorId, options.limit) ?? {
        maxMessageBytes: null,
        nullTimestampCount: 0,
      };
      if ((preflight.maxMessageBytes ?? 0) > options.maxMessageBytes) {
        throw new SensorLogExportRowTooLargeError(
          preflight.maxMessageBytes ?? 0,
          options.maxMessageBytes,
        );
      }
      if (preflight.nullTimestampCount > 0) {
        throw new MalformedSensorLogTimestampError(sensorId);
      }

      consume(this.mapRows(this.rows.iterate(sensorId, options.limit)));
    });
  }

  withRows(
    sensorId: string,
    options: { limit: number; maxMessageBytes: number },
    consume: (rows: Iterable<SensorLogExportRow>) => void,
  ): void {
    this.withinSnapshot(sensorId, options, consume);
  }

  private *mapRows(rows: Iterable<RawExportRow>): Iterable<SensorLogExportRow> {
    for (const row of rows) {
      yield {
        id: row.id,
        level: row.level as SensorLogLevel,
        message: row.message,
        timestamp: new Date(row.timestamp * 1000),
      };
    }
  }
}
