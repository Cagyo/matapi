import { describe, expect, it, vi } from "vitest";
import { TimezoneOptions } from "../../../src/config/application/ports/timezone-options.port";
import { ReadSensorLogHistoryUseCase } from "../../../src/sensors/application/read-sensor-log-history.use-case";
import { SensorLogHistoryEmptyError } from "../../../src/sensors/domain/errors/sensor-log-history-empty.error";
import { Sensor } from "../../../src/sensors/domain/sensor";
import {
  CsvTempFile,
  CsvTempFilePort,
} from "../../../src/telegram/application/ports/csv-temp-file.port";
import { StageCsvExportUseCase } from "../../../src/telegram/application/stage-csv-export.use-case";

const sensor: Sensor = {
  id: "12345678-abcdef",
  name: "front door",
  type: "digital",
  config: {},
  enabled: true,
  debounceMs: 100,
  severity: "info",
  lastValue: null,
  lastValueAt: null,
};

describe("StageCsvExportUseCase", () => {
  it("stages formatter chunks synchronously inside the bounded snapshot callback", async () => {
    let insideConsumer = false;
    const staged = {
      filename: "staged.csv",
      open: vi.fn(),
      dispose: vi.fn(),
    } as unknown as CsvTempFile;
    const files: CsvTempFilePort = {
      stage: vi.fn((filename, chunks) => {
        expect(insideConsumer).toBe(true);
        expect(filename).toBe("csv_front door_12345678_20300101T000000Z.csv");
        expect([...chunks].join("")).toContain("door");
        return staged;
      }),
      cleanupStale: vi.fn(),
    };
    const history = {
      execute: vi.fn(async (input) => {
        expect(input).toMatchObject({
          target: { kind: "id", id: sensor.id },
          limit: 5000,
          maxMessageBytes: 256 * 1024,
        });
        insideConsumer = true;
        input.consume(sensor, [
          {
            id: 1,
            level: "info",
            message: "door",
            timestamp: new Date("2030-01-01T00:00:00.000Z"),
          },
        ]);
        insideConsumer = false;
      }),
    } as unknown as ReadSensorLogHistoryUseCase;
    const timezone: TimezoneOptions = { timezone: "Europe/Kyiv" };
    const useCase = new StageCsvExportUseCase(history, files, timezone);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      await expect(
        useCase.execute({ target: { kind: "id", id: sensor.id }, limit: 5000 }),
      ).resolves.toBe(staged);
    } finally {
      vi.useRealTimers();
    }

    expect(files.stage).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty synchronous history snapshot without staging a header-only document", async () => {
    const files: CsvTempFilePort = {
      stage: vi.fn(),
      cleanupStale: vi.fn(),
    };
    const history = {
      execute: vi.fn(async (input) => {
        input.consume(sensor, []);
      }),
    } as unknown as ReadSensorLogHistoryUseCase;
    const useCase = new StageCsvExportUseCase(history, files, { timezone: "Europe/Kyiv" });

    await expect(
      useCase.execute({ target: { kind: "id", id: sensor.id }, limit: 5000 }),
    ).rejects.toBeInstanceOf(SensorLogHistoryEmptyError);

    expect(files.stage).not.toHaveBeenCalled();
  });
});
