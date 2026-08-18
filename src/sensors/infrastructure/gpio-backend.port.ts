/**
 * Seam between DigitalGpioAdapter (policy) and the GPIO transport.
 * Deliberately infrastructure, not domain/ports/: its only consumer is the
 * infrastructure adapter, and `configure({ bias, debounceUs })` is transport
 * vocabulary. Precedent: MqttConnectionPool. The interface earns its keep by
 * making the adapter's test fakes type-checked instead of `as unknown as` casts.
 */
export const GPIO_BACKEND = Symbol('GPIO_BACKEND');

export type GpioBias = 'up' | 'down' | 'none';

export interface GpioBackendState {
  available: boolean;
  /**
   * Bumps ONLY on backend-level failure → recovery (tools removed, gpio group
   * lost, chip renumbered). Per-line monitor respawns are invisible here — the
   * backend absorbs them and re-delivers a reconciled level through the same
   * `watch` callback, so one flapping sensor never forces a fleet-wide rebind.
   */
  generation: number;
}

export interface GpioLine {
  /** Record the request config; applied to each subsequent gpioget/gpiomon invocation. */
  configure(options: { bias: GpioBias; debounceUs: number }): Promise<void>;
  /**
   * Unmonitored: a real gpioget. Monitored: cached last level, bounded by
   * monitor liveness (never by level age — a healthy monitor on a quiet alarm
   * line accumulates unbounded cache age while being perfectly fine).
   * Throws on terminal classification, and when the monitor has been down
   * longer than the liveness threshold — never merely because a respawn is in
   * flight.
   */
  read(): Promise<0 | 1>;
  /**
   * Resolves once the first spawn attempt has completed — attach confirmed,
   * OR the failure classified transient and the internal retry ladder entered.
   * Rejects only on terminal classification. Resolution does NOT guarantee an
   * attached monitor. Delivers no callback before it resolves, and does not
   * synthesize an initial level on a first watch whose attach succeeded
   * immediately (the adapter has just read it). Reconciliation pushes happen
   * on respawns and on a delayed first attach.
   */
  watch(onLevel: (level: 0 | 1) => void): Promise<void>;
  unwatch(): Promise<void>;
}

export interface GpioBackendPort {
  connect(): Promise<void>;
  isAvailable(): boolean;
  state(): GpioBackendState;
  onStateChange(listener: (state: GpioBackendState) => void): () => void;
  /** Canonical per-offset singleton. Two handles for one offset would self-EBUSY. */
  line(pin: number): GpioLine;
  close(): Promise<void>;
}
