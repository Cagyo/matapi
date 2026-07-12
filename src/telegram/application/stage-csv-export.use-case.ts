import { Inject, Injectable } from "@nestjs/common";
import {
  TIMEZONE_OPTIONS,
  TimezoneOptions,
} from "../../config/application/ports/timezone-options.port";
import {
  ReadSensorLogHistoryUseCase,
  SensorLogHistoryTarget,
} from "../../sensors/application/read-sensor-log-history.use-case";
import { csvExportFilename, formatCsvRows } from "./csv-export.formatter";
import {
  CSV_TEMP_FILE,
  CsvTempFile,
  CsvTempFilePort,
} from "./ports/csv-temp-file.port";

export interface StageCsvExportInput {
  readonly target: SensorLogHistoryTarget;
  readonly limit: number;
}

@Injectable()
export class StageCsvExportUseCase {
  constructor(
    private readonly history: ReadSensorLogHistoryUseCase,
    @Inject(CSV_TEMP_FILE) private readonly files: CsvTempFilePort,
    @Inject(TIMEZONE_OPTIONS) private readonly timezone: TimezoneOptions,
  ) {}

  async execute(input: StageCsvExportInput): Promise<CsvTempFile> {
    let staged: CsvTempFile | undefined;

    await this.history.execute({
      target: input.target,
      limit: input.limit,
      maxMessageBytes: 256 * 1024,
      consume: (sensor, rows) => {
        staged = this.files.stage(
          csvExportFilename(sensor, new Date()),
          formatCsvRows(sensor, rows, this.timezone.timezone),
        );
      },
    });

    if (!staged) {
      throw new Error("Sensor log history did not provide a CSV snapshot");
    }
    return staged;
  }
}
