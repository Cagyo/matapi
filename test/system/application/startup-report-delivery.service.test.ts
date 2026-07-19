import { describe, expect, it, vi } from "vitest";
import { StartupReportDeliveryService } from "../../../src/system/application/startup-report-delivery.service";
import type { StartupReport } from "../../../src/system/domain/ota-contracts";

const report: StartupReport = {
  schemaVersion: 1,
  operationId: null,
  kind: null,
  outcome: "maintenance-required",
  artifactSha256: null,
  metadataSha256: null,
  failure: { code: "maintenance-required" },
  writtenAt: "2030-01-01T00:00:00.000Z",
};

describe("StartupReportDeliveryService", () => {
  it("retains reports before registration and delegates after Telegram registers", async () => {
    const service = new StartupReportDeliveryService();
    await expect(service.deliver(report)).resolves.toEqual({ delivered: 0 });

    const delivery = { deliver: vi.fn(async () => ({ delivered: 1 })) };
    service.register(delivery);
    await expect(service.deliver(report)).resolves.toEqual({ delivered: 1 });

    service.clear();
    await expect(service.deliver(report)).resolves.toEqual({ delivered: 0 });
    expect(delivery.deliver).toHaveBeenCalledWith(report);
  });
});
