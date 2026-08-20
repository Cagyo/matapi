export const WATCHDOG = Symbol('WATCHDOG');

/**
 * Outbound port for the Pi hardware watchdog (`bcm2835_wdt`, spec 22). The
 * worker opens the device, pets it on an interval, and closes it gracefully
 * on shutdown. If the process dies without petting, the watchdog reboots the
 * Pi after its timeout. Device/file concerns live in the adapter.
 */
export interface WatchdogPort {
  /**
   * Open the watchdog device. Petting must follow within the kernel timeout.
   * Must not leave a resource acquired if it throws: the caller treats a
   * failed open as "never opened" and will not call `close()`, so an adapter
   * that acquires a handle and then throws leaks the fd with the device armed.
   */
  open(): Promise<void>;

  /** Pet the watchdog to defer the reboot timer. */
  pet(): Promise<void>;

  /** Disarm and close the watchdog gracefully (no reboot on clean shutdown). */
  close(): Promise<void>;
}
