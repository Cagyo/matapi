/**
 * Optional driver capability used by the development simulator (spec 26).
 *
 * Mock adapters (`MockGpioAdapter`, `MockUartCo2Adapter`) implement this so the
 * `/dev/simulate` panel can push readings through the exact same pipeline as
 * real hardware. Production adapters do not implement it.
 */
export interface SimulatableSensorPort {
  /** Apply a simulated raw reading (digital: 0/1, uart: ppm). */
  simulate(value: number): void;
}

/** Narrow an arbitrary driver to one that supports dev simulation. */
export function isSimulatable(driver: object): driver is SimulatableSensorPort {
  return typeof (driver as Partial<SimulatableSensorPort>).simulate === 'function';
}
