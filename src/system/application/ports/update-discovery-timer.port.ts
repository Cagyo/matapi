export const UPDATE_DISCOVERY_TIMER = Symbol("UPDATE_DISCOVERY_TIMER");

export type UpdateDiscoveryTimerHandle = object | number;

export interface UpdateDiscoveryTimerPort {
  setTimeout(callback: () => void, delayMs: number): UpdateDiscoveryTimerHandle;
  clearTimeout(handle: UpdateDiscoveryTimerHandle): void;
  setInterval(
    callback: () => void,
    delayMs: number,
  ): UpdateDiscoveryTimerHandle;
  clearInterval(handle: UpdateDiscoveryTimerHandle): void;
}
