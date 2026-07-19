import { describe, expect, it, vi } from "vitest";
import { ConsumeStartupReportUseCase } from "../../../src/system/application/consume-startup-report.use-case";
import type { StartupReport } from "../../../src/system/domain/ota-contracts";

const report: StartupReport = {
  schemaVersion: 1,
  operationId: "AAAAAAAAAAAAAAAAAAAAAA",
  kind: "update",
  outcome: "updated",
  artifactSha256: "a".repeat(64),
  metadataSha256: "b".repeat(64),
  failure: null,
  writtenAt: "2030-01-01T00:00:00.000Z",
};

function fixture(deliveries: number | Error) {
  const events: string[] = [];
  const acknowledge = vi.fn(async () => events.push("ack"));
  const useCase = new ConsumeStartupReportUseCase({
    reports: {
      read: vi.fn(async () => {
        events.push("read");
        return report;
      }),
      acknowledge,
    },
    mirror: {
      mirror: vi.fn(async () => events.push("mirror")),
    },
    delivery: {
      deliver: vi.fn(async () => {
        events.push("deliver");
        if (deliveries instanceof Error) throw deliveries;
        return { delivered: deliveries };
      }),
    },
  });
  return { useCase, events, acknowledge };
}

describe("ConsumeStartupReportUseCase", () => {
  it("retains the report across a delivery crash and acknowledges the retry", async () => {
    const failed = fixture(new Error("crash"));
    await expect(failed.useCase.execute()).rejects.toThrow("crash");
    expect(failed.acknowledge).not.toHaveBeenCalled();

    const retried = fixture(1);
    await retried.useCase.execute();
    expect(retried.events).toEqual(["read", "mirror", "deliver", "ack"]);
  });

  it("does not acknowledge a zero-recipient report", async () => {
    const setup = fixture(0);
    await setup.useCase.execute();
    expect(setup.acknowledge).not.toHaveBeenCalled();
  });
});
