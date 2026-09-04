import { describe, expect, it } from "vitest";

import { GetLiveViewSettingsUseCase } from "../../../src/camera/application/get-live-view-settings.use-case";
import { LiveViewSettingsStateError } from "../../../src/camera/domain/errors/live-view-settings-state.error";
import type { LiveViewMigrationAttentionPort } from "../../../src/camera/domain/ports/live-view-migration-attention.port";
import type { LiveViewSettingsStorePort } from "../../../src/camera/domain/ports/live-view-settings-store.port";

const configured = {
  version: 1 as const,
  generation: 4,
  enabled: true,
  allowedCameraCidrs: ["192.168.1.0/24"],
};

describe("GetLiveViewSettingsUseCase", () => {
  it("projects configured-versus-active generations and migration attention", async () => {
    const useCase = new GetLiveViewSettingsUseCase(
      store({ bootGeneration: 3 }),
      attention("legacy-values-invalid"),
    );

    await expect(useCase.execute()).resolves.toEqual({
      configured,
      bootLoadedGeneration: 3,
      restartRequired: true,
      migrationAttention: "legacy-values-invalid",
      repairRequired: false,
    });
  });

  it("reports no restart when the configured generation is active", async () => {
    const useCase = new GetLiveViewSettingsUseCase(
      store({ bootGeneration: 4 }),
      attention(null),
    );

    await expect(useCase.execute()).resolves.toEqual({
      configured,
      bootLoadedGeneration: 4,
      restartRequired: false,
      migrationAttention: null,
      repairRequired: false,
    });
  });

  it("fails closed to a sanitized repair projection when settings cannot be read", async () => {
    const useCase = new GetLiveViewSettingsUseCase(
      store({ readError: new Error("raw adapter detail") }),
      attention(null),
    );

    await expect(useCase.execute()).resolves.toEqual({
      configured: null,
      bootLoadedGeneration: null,
      restartRequired: false,
      migrationAttention: null,
      repairRequired: true,
    });
  });

  it("fails closed to repair without exposing an invalid attention marker error", async () => {
    const useCase = new GetLiveViewSettingsUseCase(
      store({ bootGeneration: 4 }),
      {
        read: async () => {
          throw new LiveViewSettingsStateError();
        },
      },
    );

    await expect(useCase.execute()).resolves.toEqual({
      configured,
      bootLoadedGeneration: 4,
      restartRequired: false,
      migrationAttention: null,
      repairRequired: true,
    });
  });
});

function store(input: {
  readonly bootGeneration?: number | null;
  readonly readError?: Error;
}): LiveViewSettingsStorePort {
  return {
    readCommitted: async () => {
      if (input.readError) throw input.readError;
      return configured;
    },
    bootLoadedGeneration: () => input.bootGeneration ?? null,
    simulateDevelopmentRestart: async () => undefined,
  };
}

function attention(
  value: "legacy-values-invalid" | null,
): LiveViewMigrationAttentionPort {
  return { read: async () => value };
}
