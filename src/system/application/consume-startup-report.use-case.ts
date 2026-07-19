import {
  parseStartupReport,
  type StartupReport,
} from "../domain/ota-contracts";

export interface StartupReportStorePort {
  read(): Promise<unknown>;
  acknowledge(report: StartupReport): Promise<void>;
}

export interface StartupReportMirrorPort {
  mirror(report: StartupReport): Promise<void>;
}

export interface StartupReportDeliveryPort {
  deliver(report: StartupReport): Promise<{ delivered: number }>;
}

export interface ConsumeStartupReportDependencies {
  reports: StartupReportStorePort;
  mirror: StartupReportMirrorPort;
  delivery: StartupReportDeliveryPort;
}

export class ConsumeStartupReportUseCase {
  constructor(
    private readonly dependencies: ConsumeStartupReportDependencies,
  ) {}

  async execute(): Promise<StartupReport | null> {
    const source = await this.dependencies.reports.read();
    if (source === null) return null;
    const report = parseStartupReport(source);
    await this.dependencies.mirror.mirror(report);
    const delivery = await this.dependencies.delivery.deliver(report);
    if (!Number.isSafeInteger(delivery.delivered) || delivery.delivered < 0) {
      throw new Error("invalid startup report delivery count");
    }
    if (delivery.delivered > 0) {
      await this.dependencies.reports.acknowledge(report);
    }
    return report;
  }
}
