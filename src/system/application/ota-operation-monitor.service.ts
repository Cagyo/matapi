import { Injectable, Logger } from "@nestjs/common";
import { ConsumeStartupReportUseCase } from "./consume-startup-report.use-case";

@Injectable()
export class OtaOperationMonitorService {
  private readonly logger = new Logger(OtaOperationMonitorService.name);

  constructor(
    private readonly consumeStartupReport: ConsumeStartupReportUseCase,
  ) {}

  async runOnce(): Promise<void> {
    await this.consumeStartupReport.execute();
  }

  async runBestEffort(): Promise<void> {
    try {
      await this.runOnce();
    } catch {
      this.logger.warn("OTA startup report delivery deferred");
    }
  }
}
