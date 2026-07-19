import { Injectable } from "@nestjs/common";
import type { StartupReport } from "../domain/ota-contracts";
import type { StartupReportDeliveryPort } from "./consume-startup-report.use-case";

/** System-owned registration seam; Telegram supplies the outer delivery adapter. */
@Injectable()
export class StartupReportDeliveryService implements StartupReportDeliveryPort {
  private delegate?: StartupReportDeliveryPort;

  register(delegate: StartupReportDeliveryPort): void {
    this.delegate = delegate;
  }

  clear(): void {
    this.delegate = undefined;
  }

  deliver(report: StartupReport): Promise<{ delivered: number }> {
    return this.delegate?.deliver(report) ?? Promise.resolve({ delivered: 0 });
  }
}
