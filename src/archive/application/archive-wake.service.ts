import { Injectable } from '@nestjs/common';

/** Monotonic lost-wake-safe notification boundary for the archive drain pump. */
@Injectable()
export class ArchiveWakeService {
  private epoch = 0;
  private readonly waiters = new Set<() => void>();

  snapshot(): number {
    return this.epoch;
  }

  wake(): void {
    this.epoch += 1;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async waitForChange(
    expectedEpoch: number,
    deadlineMs: number | null,
    maximumSleepMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw abortReason(signal);
    const nowMs = Date.now();
    const delayMs = Math.max(
      0,
      Math.min(maximumSleepMs, (deadlineMs ?? nowMs + maximumSleepMs) - nowMs),
    );
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        reject(abortReason(signal));
      };
      const timer = setTimeout(finish, delayMs);
      timer.unref?.();
      this.waiters.add(finish);
      signal.addEventListener('abort', abort, { once: true });
      if (this.epoch !== expectedEpoch) finish();
    });
  }
}

/** Compatibility instance used until the archive composition root wires this service explicitly. */
export const DEFAULT_ARCHIVE_WAKE_SERVICE = new ArchiveWakeService();

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}
