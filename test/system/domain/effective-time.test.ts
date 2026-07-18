import { describe, expect, it, vi } from "vitest";
import {
  captureEffectiveCheckTime,
  deriveEffectiveTime,
  shouldPersistTimeAnchor,
} from "../../../src/system/domain/effective-time";
import type {
  OtaClockPort,
  OtaClockSnapshot,
} from "../../../src/system/domain/ports/ota-clock.port";
import { ProcOtaClockAdapter } from "../../../src/system/infrastructure/proc-ota-clock.adapter";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function clock(
  bootId: string,
  wallMs: number,
  monotonicMs: number,
  synchronized = true,
): OtaClockSnapshot {
  return { synchronized, wallMs, monotonicMs, bootId };
}

function anchor(
  bootId: string,
  wallMs: number,
  monotonicMs: number,
  persistedAtMs = wallMs,
) {
  return { wallMs, monotonicMs, bootId, persistedAtMs };
}

describe("effective OTA check time", () => {
  it("rejects an unsynchronized clock", () => {
    try {
      deriveEffectiveTime(clock("boot-a", 1_000, 50, false), null);
      throw new Error("expected clock rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "clock-unsynchronized" });
    }
  });

  it("rejects wall-clock rollback beyond five minutes", () => {
    try {
      deriveEffectiveTime(
        clock("boot-b", 1_000, 50),
        anchor("old", 400_001, 0),
      );
      throw new Error("expected clock rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "clock-rollback" });
    }
  });

  it("allows exactly five minutes of wall-clock rollback", () => {
    expect(
      deriveEffectiveTime(
        clock("boot-b", 100_000, 50),
        anchor("old", 400_000, 0),
      ).effectiveMs,
    ).toBe(400_000);
  });

  it("reuses monotonic advancement only within the same boot", () => {
    expect(
      deriveEffectiveTime(clock("boot-b", 200, 30), anchor("boot-a", 500, 10))
        .effectiveMs,
    ).toBe(500);
    expect(
      deriveEffectiveTime(clock("boot-a", 200, 30), anchor("boot-a", 500, 10))
        .effectiveMs,
    ).toBe(520);
  });

  it("captures one snapshot and returns a reusable fixed check time", async () => {
    const capture = vi.fn(async () => clock("boot-a", 1_000, 50));
    const port: OtaClockPort = { capture };

    const result = await captureEffectiveCheckTime(
      port,
      anchor("boot-a", 900, 0),
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(result.effectiveMs).toBe(1_000);
    expect(result.checkTime).toEqual(new Date(1_000));
    expect(result.anchor).toEqual(anchor("boot-a", 1_000, 50));
  });

  it("persists the floor on metadata advance or after six hours", () => {
    const priorAnchor = anchor("boot-a", 1_000, 10);

    expect(
      shouldPersistTimeAnchor({
        metadataAdvanced: true,
        effectiveMs: 1_001,
        priorAnchor,
      }),
    ).toBe(true);
    expect(
      shouldPersistTimeAnchor({
        metadataAdvanced: false,
        effectiveMs: 1_000 + SIX_HOURS_MS - 1,
        priorAnchor,
      }),
    ).toBe(false);
    expect(
      shouldPersistTimeAnchor({
        metadataAdvanced: false,
        effectiveMs: 1_000 + SIX_HOURS_MS,
        priorAnchor,
      }),
    ).toBe(true);
  });

  it("persists the first synchronized floor", () => {
    expect(
      shouldPersistTimeAnchor({
        metadataAdvanced: false,
        effectiveMs: 1_000,
        priorAnchor: null,
      }),
    ).toBe(true);
  });
});

describe("ProcOtaClockAdapter", () => {
  it("combines the clock-sync probe with wall, monotonic, and Linux boot ID readings", async () => {
    const adapter = new ProcOtaClockAdapter(
      { probe: async () => ({ synchronized: true, offsetMs: null }) },
      {
        wallNow: () => 123,
        readMonotonicMs: () => 45,
        readBootId: () => " boot-123\n",
      },
    );

    await expect(adapter.capture()).resolves.toEqual({
      synchronized: true,
      wallMs: 123,
      monotonicMs: 45,
      bootId: "boot-123",
    });
  });

  it("fails closed when the proc boot ID is empty", async () => {
    const adapter = new ProcOtaClockAdapter(
      { probe: async () => ({ synchronized: true, offsetMs: null }) },
      {
        wallNow: () => 123,
        readMonotonicMs: () => 45,
        readBootId: () => "\n",
      },
    );

    await expect(adapter.capture()).rejects.toThrow(/boot ID/i);
  });
});
