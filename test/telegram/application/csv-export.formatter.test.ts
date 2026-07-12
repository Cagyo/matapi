import { describe, expect, it } from "vitest";
import { formatCsvRows } from "../../../src/telegram/application/csv-export.formatter";
import { Sensor } from "../../../src/sensors/domain/sensor";
import { SensorLogExportRow } from "../../../src/sensors/domain/ports/sensor-log-export-reader.port";

const sensor: Sensor = {
  id: "12345678-abcdef",
  name: "door",
  type: "digital",
  config: {},
  enabled: true,
  debounceMs: 100,
  severity: "info",
  lastValue: null,
  lastValueAt: null,
};

function row(
  message: string,
  timestamp = new Date("2030-01-01T00:00:00.000Z"),
): SensorLogExportRow {
  return { id: 1, level: "info", message, timestamp };
}

describe("formatCsvRows", () => {
  it("emits BOM, CRLF, formula-safe text, and binary values", () => {
    expect(
      [
        ...formatCsvRows(
          sensor,
          [row("State changed: CLOSED → OPEN"), row("=danger")],
          "Europe/Kyiv",
        ),
      ].join(""),
    ).toBe(
      "\uFEFFtimestamp_utc,timestamp_local,sensor_name,level,value,message\r\n" +
        "2030-01-01T00:00:00.000Z,2030-01-01 02:00:00 +02:00,door,info,1,State changed: CLOSED → OPEN\r\n" +
        '2030-01-01T00:00:00.000Z,2030-01-01 02:00:00 +02:00,door,info,,"\'=danger"\r\n',
    );
  });

  it("RFC4180-escapes non-ASCII text and protects formulas after whitespace", () => {
    const namedSensor = { ...sensor, name: 'Вхід, "ліва"' };

    expect(
      [
        ...formatCsvRows(
          namedSensor,
          [row('\t-1,"тест"\nnext')],
          "Europe/Kyiv",
        ),
      ].join(""),
    ).toContain('"Вхід, ""ліва""",info,,"\'\t-1,""тест""\nnext"\r\n');
  });

  it("formats local timestamps with the DST offset", () => {
    expect(
      [
        ...formatCsvRows(
          sensor,
          [row("ppm=403.5", new Date("2030-07-01T00:00:00.000Z"))],
          "Europe/Kyiv",
        ),
      ].join(""),
    ).toContain(
      "2030-07-01T00:00:00.000Z,2030-07-01 03:00:00 +03:00,door,info,403.5,ppm=403.5\r\n",
    );
  });

  it.each([
    ["CLOSED", "0"],
    ["DRY", "0"],
    ["NORMAL", "0"],
    ["GRID OK", "0"],
    ["CLEAR", "0"],
    ["RELEASED", "0"],
    ["OPEN", "1"],
    ["OPENED", "1"],
    ["LEAK DETECTED", "1"],
    ["ALARM", "1"],
    ["OUTAGE", "1"],
    ["MOTION", "1"],
    ["PRESSED", "1"],
  ])("maps known binary destination %s to %s", (destination, expectedValue) => {
    const document = [
      ...formatCsvRows(
        sensor,
        [row(`State changed: old → ${destination}`)],
        "Europe/Kyiv",
      ),
    ].join("");

    expect(document).toContain(
      `door,info,${expectedValue},State changed: old → ${destination}\r\n`,
    );
  });

  it("only accepts complete state changes and prioritizes ppm values", () => {
    const document = [
      ...formatCsvRows(
        sensor,
        [
          row("prefix State changed: old → OPEN"),
          row("State changed: old -> OPEN"),
          row("State changed: old → UNKNOWN"),
          row("ppm=100 State changed: old → CLOSED"),
        ],
        "Europe/Kyiv",
      ),
    ].join("");

    expect(document).toContain(
      "door,info,,prefix State changed: old → OPEN\r\n",
    );
    expect(document).toContain("door,info,,State changed: old -> OPEN\r\n");
    expect(document).toContain("door,info,,State changed: old → UNKNOWN\r\n");
    expect(document).toContain(
      "door,info,100,ppm=100 State changed: old → CLOSED\r\n",
    );
  });
});
