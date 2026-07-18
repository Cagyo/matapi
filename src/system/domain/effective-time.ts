import type { TimeAnchor } from "./ota-contracts";
import type { OtaClockPort, OtaClockSnapshot } from "./ports/ota-clock.port";

const MAX_WALL_ROLLBACK_MS = 5 * 60 * 1000;
const TIME_FLOOR_PERSIST_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface EffectiveCheckTime {
  effectiveMs: number;
  checkTime: Date;
  anchor: TimeAnchor;
}

export interface PersistTimeAnchorInput {
  metadataAdvanced: boolean;
  effectiveMs: number;
  priorAnchor: TimeAnchor | null;
}

export type OtaClockFailureCode = "clock-unsynchronized" | "clock-rollback";

export class OtaClockError extends Error {
  constructor(readonly code: OtaClockFailureCode) {
    super(code);
    this.name = "OtaClockError";
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`invalid OTA clock: ${label}`);
}

function validateSnapshot(snapshot: OtaClockSnapshot): void {
  assertNonNegativeSafeInteger(snapshot.wallMs, "wallMs");
  assertNonNegativeSafeInteger(snapshot.monotonicMs, "monotonicMs");
  if (snapshot.bootId.trim().length === 0)
    throw new Error("invalid OTA clock: boot ID is empty");
}

function validateAnchor(anchor: TimeAnchor): void {
  assertNonNegativeSafeInteger(anchor.wallMs, "anchor.wallMs");
  assertNonNegativeSafeInteger(anchor.monotonicMs, "anchor.monotonicMs");
  assertNonNegativeSafeInteger(anchor.persistedAtMs, "anchor.persistedAtMs");
  if (anchor.bootId.trim().length === 0)
    throw new Error("invalid OTA clock: anchor boot ID is empty");
}

export function deriveEffectiveTime(
  snapshot: OtaClockSnapshot,
  priorAnchor: TimeAnchor | null,
): EffectiveCheckTime {
  validateSnapshot(snapshot);
  if (!snapshot.synchronized) throw new OtaClockError("clock-unsynchronized");

  let effectiveMs = snapshot.wallMs;
  if (priorAnchor !== null) {
    validateAnchor(priorAnchor);
    const priorFloor = Math.max(priorAnchor.wallMs, priorAnchor.persistedAtMs);
    if (snapshot.wallMs + MAX_WALL_ROLLBACK_MS < priorFloor)
      throw new OtaClockError("clock-rollback");

    effectiveMs = Math.max(effectiveMs, priorFloor);
    if (
      snapshot.bootId === priorAnchor.bootId &&
      snapshot.monotonicMs >= priorAnchor.monotonicMs
    ) {
      effectiveMs = Math.max(
        effectiveMs,
        priorAnchor.wallMs + (snapshot.monotonicMs - priorAnchor.monotonicMs),
      );
    }
  }

  assertNonNegativeSafeInteger(effectiveMs, "effectiveMs");
  return {
    effectiveMs,
    checkTime: new Date(effectiveMs),
    anchor: {
      wallMs: effectiveMs,
      monotonicMs: snapshot.monotonicMs,
      bootId: snapshot.bootId,
      persistedAtMs: effectiveMs,
    },
  };
}

export async function captureEffectiveCheckTime(
  clock: OtaClockPort,
  priorAnchor: TimeAnchor | null,
): Promise<EffectiveCheckTime> {
  return deriveEffectiveTime(await clock.capture(), priorAnchor);
}

export function shouldPersistTimeAnchor({
  metadataAdvanced,
  effectiveMs,
  priorAnchor,
}: PersistTimeAnchorInput): boolean {
  assertNonNegativeSafeInteger(effectiveMs, "effectiveMs");
  if (priorAnchor === null) return true;
  validateAnchor(priorAnchor);
  return (
    metadataAdvanced ||
    effectiveMs - priorAnchor.persistedAtMs >= TIME_FLOOR_PERSIST_INTERVAL_MS
  );
}
