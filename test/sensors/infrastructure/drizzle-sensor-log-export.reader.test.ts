import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensorLogs } from '../../../src/database/schema';
import { MalformedSensorLogTimestampError } from '../../../src/sensors/domain/errors/malformed-sensor-log-timestamp.error';
import { SensorLogExportRowTooLargeError } from '../../../src/sensors/domain/errors/sensor-log-export-row-too-large.error';
import { DrizzleSensorLogExportReader } from '../../../src/sensors/infrastructure/drizzle-sensor-log-export.reader';
import {
  createTestDatabase,
  TestDatabaseContext,
} from '../../helpers/database';

describe('DrizzleSensorLogExportReader', () => {
  let context: TestDatabaseContext;
  let reader: DrizzleSensorLogExportReader;

  beforeEach(() => {
    context = createTestDatabase();
    reader = new DrizzleSensorLogExportReader(context.sqlite);
  });

  afterEach(() => context.close());

  it('selects the newest limit rows but consumes those rows oldest first with id ties', () => {
    context.sqlite
      .prepare(
        `INSERT INTO sensor_logs (id, sensor_id, level, message, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(1, 's1', 'info', 'oldest', 1_893_456_000);
    context.sqlite
      .prepare(
        `INSERT INTO sensor_logs (id, sensor_id, level, message, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(2, 's1', 'info', 'same timestamp first', 1_893_542_400);
    context.sqlite
      .prepare(
        `INSERT INTO sensor_logs (id, sensor_id, level, message, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(3, 's1', 'info', 'same timestamp second', 1_893_542_400);

    const ids: number[] = [];
    reader.withRows('s1', { limit: 2, maxMessageBytes: 256 * 1024 }, (rows) => {
      for (const row of rows) ids.push(row.id);
    });

    expect(ids).toEqual([2, 3]);
  });

  it('rejects an oversized selected row before invoking the consumer', () => {
    context.sqlite
      .prepare(
        `INSERT INTO sensor_logs (sensor_id, level, message, timestamp)
         VALUES (?, ?, ?, ?)`,
      )
      .run('s1', 'info', 'ééé', 1_893_542_400);
    let consumed = false;

    expect(() =>
      reader.withRows('s1', { limit: 1, maxMessageBytes: 5 }, () => {
        consumed = true;
      }),
    ).toThrow(SensorLogExportRowTooLargeError);
    expect(consumed).toBe(false);
  });

  it('rejects a selected row with a null timestamp before invoking the consumer', () => {
    context.sqlite
      .prepare(
        `INSERT INTO sensor_logs (sensor_id, level, message, timestamp)
         VALUES (?, ?, ?, NULL)`,
      )
      .run('s1', 'info', 'missing timestamp');
    let consumed = false;

    expect(() =>
      reader.withRows('s1', { limit: 1, maxMessageBytes: 256 * 1024 }, () => {
        consumed = true;
      }),
    ).toThrow(MalformedSensorLogTimestampError);
    expect(consumed).toBe(false);
  });

  it('returns the identical millisecond for a Date inserted through Drizzle', () => {
    const timestamp = new Date('2030-01-02T03:04:05.000Z');
    context.db
      .insert(sensorLogs)
      .values({ sensorId: 's1', level: 'warn', message: 'inserted by Drizzle', timestamp })
      .run();
    const rows: Date[] = [];

    reader.withRows('s1', { limit: 1, maxMessageBytes: 256 * 1024 }, (snapshot) => {
      for (const row of snapshot) {
        if (row.timestamp) rows.push(row.timestamp);
      }
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].getTime()).toBe(timestamp.getTime());
  });
});
