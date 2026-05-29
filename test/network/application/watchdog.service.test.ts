import { afterEach, describe, expect, it, vi } from 'vitest';
import { WatchdogService } from '../../../src/network/application/watchdog.service';
import type { WatchdogPort } from '../../../src/network/domain/ports/watchdog.port';

function fakeWatchdog(): WatchdogPort & {
  open: ReturnType<typeof vi.fn>;
  pet: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    open: vi.fn().mockResolvedValue(undefined),
    pet: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('WatchdogService', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.WATCHDOG_PET_INTERVAL_MS;
  });

  it('does nothing when disabled', async () => {
    const watchdog = fakeWatchdog();
    const service = new WatchdogService(false, watchdog);

    await service.onApplicationBootstrap();
    await service.onModuleDestroy();

    expect(watchdog.open).not.toHaveBeenCalled();
    expect(watchdog.close).not.toHaveBeenCalled();
  });

  it('opens, pets on the interval, and disarms on destroy when enabled', async () => {
    process.env.WATCHDOG_PET_INTERVAL_MS = '15000';
    vi.useFakeTimers();
    const watchdog = fakeWatchdog();
    const service = new WatchdogService(true, watchdog);

    await service.onApplicationBootstrap();
    expect(watchdog.open).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(15000);
    expect(watchdog.pet).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
    expect(watchdog.close).toHaveBeenCalledTimes(1);

    watchdog.pet.mockClear();
    await vi.advanceTimersByTimeAsync(15000);
    expect(watchdog.pet).not.toHaveBeenCalled();
  });

  it('keeps petting after a failed pet', async () => {
    process.env.WATCHDOG_PET_INTERVAL_MS = '15000';
    vi.useFakeTimers();
    const watchdog = fakeWatchdog();
    watchdog.pet.mockRejectedValueOnce(new Error('write failed'));
    const service = new WatchdogService(true, watchdog);

    await service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(15000);

    expect(watchdog.pet).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });
});
