import { Inject, Injectable } from '@nestjs/common';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { CLOCK, ClockPort } from '../domain/ports/clock.port';

/**
 * Per-sensor debounce (spec 19). Suppresses repeated **identical** state
 * notifications (e.g. door OPEN→OPEN) within the sensor's `debounceMs`
 * window. Real transitions (OPEN→CLOSE) are always delivered. Debounce is
 * per-sensor, not per-user. Sensor metadata is read through `SensorQueryPort`
 * — this context never touches the sensors schema directly.
 */
@Injectable()
export class DebounceService {
  private readonly lastNotified = new Map<string, { value: unknown; at: number }>();

  constructor(
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /**
   * Returns `true` when the sensor should notify for `newValue`. On a `true`
   * decision the last-notified marker is updated so the next identical value
   * is debounced. A changed value always notifies and resets the window.
   */
  async shouldNotify(sensorId: string, newValue: unknown): Promise<boolean> {
    const now = this.clock.now().getTime();
    const last = this.lastNotified.get(sensorId);

    if (!last || last.value !== newValue) {
      this.lastNotified.set(sensorId, { value: newValue, at: now });
      return true;
    }

    const sensor = await this.sensors.findById(sensorId);
    const debounceMs = sensor?.debounceMs ?? 0;
    if (now - last.at >= debounceMs) {
      this.lastNotified.set(sensorId, { value: newValue, at: now });
      return true;
    }

    return false;
  }
}
