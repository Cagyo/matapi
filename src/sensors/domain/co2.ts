export type Co2Level = 'normal' | 'warning' | 'critical';

export interface Co2Thresholds {
  warning: number;
  critical: number;
}

export const CO2_PPM_RANGE = { min: 0, max: 5000 } as const;

/** Returns true if `ppm` is inside the sane physical range (0–5000). */
export function isValidPpm(ppm: number | null | undefined): ppm is number {
  return (
    typeof ppm === 'number' &&
    Number.isFinite(ppm) &&
    ppm >= CO2_PPM_RANGE.min &&
    ppm <= CO2_PPM_RANGE.max
  );
}

export function classifyCo2(ppm: number, thresholds: Co2Thresholds): Co2Level {
  if (ppm >= thresholds.critical) return 'critical';
  if (ppm >= thresholds.warning) return 'warning';
  return 'normal';
}
