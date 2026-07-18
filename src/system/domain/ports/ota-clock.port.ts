export const OTA_CLOCK = Symbol("OTA_CLOCK");

export interface OtaClockSnapshot {
  synchronized: boolean;
  wallMs: number;
  monotonicMs: number;
  bootId: string;
}

/** Captures one coherent clock sample for an OTA check cycle. */
export interface OtaClockPort {
  capture(): Promise<OtaClockSnapshot>;
}
