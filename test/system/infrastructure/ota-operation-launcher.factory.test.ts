import { describe, expect, it } from "vitest";
import { OTA_OPERATION_LAUNCHER } from "../../../src/system/domain/ports/ota-operation-launcher.port";
import { FlockOtaOperationLauncherAdapter } from "../../../src/system/infrastructure/flock-ota-operation-launcher.adapter";
import { otaOperationLauncherForMode } from "../../../src/system/infrastructure/ota-operation-launcher.factory";
import { StubOtaOperationLauncherAdapter } from "../../../src/system/infrastructure/stub-ota-operation-launcher.adapter";
import type { OtaConfig } from "../../../src/system/infrastructure/ota-discovery-config.loader";
import { SystemModule } from "../../../src/system/system.module";

describe("otaOperationLauncherForMode", () => {
  it("binds an inert launcher in stub mode", async () => {
    const launcher = otaOperationLauncherForMode("stub", {} as OtaConfig);

    expect(launcher).toBeInstanceOf(StubOtaOperationLauncherAdapter);
    await expect(launcher.startRollback()).resolves.toEqual({
      kind: "rejected",
      failure: { code: "maintenance-required" },
    });
  });

  it("binds the flock launcher only in real mode", () => {
    const config = {
      launcher: {},
    } as OtaConfig;

    expect(otaOperationLauncherForMode("real", config)).toBeInstanceOf(
      FlockOtaOperationLauncherAdapter,
    );
  });

  it("uses the explicit stub selection in the test-mode SystemModule", () => {
    const providers = Reflect.getMetadata("providers", SystemModule) as {
      provide?: symbol;
      useValue?: unknown;
    }[];
    const provider = providers.find(
      (candidate) => candidate.provide === OTA_OPERATION_LAUNCHER,
    );

    expect(provider?.useValue).toBeInstanceOf(StubOtaOperationLauncherAdapter);
  });
});
