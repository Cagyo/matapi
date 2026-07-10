import { SensorType } from './sensor';

export const DEFAULT_DIGITAL_DEBOUNCE_MS = 100;

/** Default debounce used only when a sensor has no explicit stored value. */
export function defaultDebounceMs(type: SensorType): number {
  if (type === 'digital') return DEFAULT_DIGITAL_DEBOUNCE_MS;
  if (type === 'uart') return 0;
  return 10_000;
}
