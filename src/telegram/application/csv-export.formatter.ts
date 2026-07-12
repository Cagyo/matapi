import { formatInTimeZone } from "date-fns-tz";
import { SensorLogExportRow } from "../../sensors/domain/ports/sensor-log-export-reader.port";

const HEADER =
  "timestamp_utc,timestamp_local,sensor_name,level,value,message\r\n";
const FORMULA_PREFIX = /^[ \t\r\n]*[=+\-@]/;
const PPM_VALUE = /ppm=([+-]?(?:\d+(?:\.\d+)?|\.\d+))/i;
const STATE_CHANGED = /^State changed:\s*(.+?)\s+→\s*(.+?)\s*$/i;
const BINARY_VALUES = new Map<string, 0 | 1>([
  ["CLOSED", 0],
  ["DRY", 0],
  ["NORMAL", 0],
  ["GRID OK", 0],
  ["CLEAR", 0],
  ["RELEASED", 0],
  ["OPEN", 1],
  ["OPENED", 1],
  ["LEAK DETECTED", 1],
  ["ALARM", 1],
  ["OUTAGE", 1],
  ["MOTION", 1],
  ["PRESSED", 1],
]);

export interface CsvExportSensor {
  readonly id: string;
  readonly name: string;
}

export function* formatCsvRows(
  sensor: CsvExportSensor,
  rows: Iterable<SensorLogExportRow>,
  timezone: string,
): Iterable<string> {
  yield `\uFEFF${HEADER}`;

  for (const row of rows) {
    const timestampUtc = row.timestamp?.toISOString() ?? "";
    const timestampLocal = row.timestamp
      ? formatInTimeZone(row.timestamp, timezone, "yyyy-MM-dd HH:mm:ss XXX")
      : "";
    yield [
      csvText(timestampUtc),
      csvText(timestampLocal),
      csvText(sensor.name),
      csvText(row.level),
      csvValue(row.message),
      csvText(row.message),
    ].join(",") + "\r\n";
  }
}

export function csvExportFilename(sensor: CsvExportSensor, now: Date): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `csv_${sensor.name}_${sensor.id.slice(0, 8)}_${timestamp}.csv`;
}

function csvValue(message: string): string {
  const ppm = PPM_VALUE.exec(message);
  if (ppm) return ppm[1];

  const changed = STATE_CHANGED.exec(message);
  if (!changed) return "";

  const destination = changed[2].trim().replace(/\s+/g, " ").toUpperCase();
  return BINARY_VALUES.get(destination)?.toString() ?? "";
}

function csvText(value: string): string {
  const protectedValue = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(protectedValue) || protectedValue !== value
    ? `"${protectedValue.replace(/"/g, '""')}"`
    : protectedValue;
}
