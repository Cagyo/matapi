import { describe, expect, it, vi } from "vitest";
import { OtaOperationMonitorService } from "../../../src/system/application/ota-operation-monitor.service";
import type { ConsumeStartupReportUseCase } from "../../../src/system/application/consume-startup-report.use-case";

describe("OtaOperationMonitorService", () => {
  it("runs startup report consumption as an optional fast path", async () => {
    const execute = vi.fn().mockResolvedValue(null);
    const monitor = new OtaOperationMonitorService({
      execute,
    } as unknown as ConsumeStartupReportUseCase);

    await monitor.runOnce();

    expect(execute).toHaveBeenCalledOnce();
  });

  it("retains the report and lets boot continue when fast-path delivery fails", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("delivery failed"));
    const monitor = new OtaOperationMonitorService({
      execute,
    } as unknown as ConsumeStartupReportUseCase);

    await expect(monitor.runBestEffort()).resolves.toBeUndefined();
  });
});
