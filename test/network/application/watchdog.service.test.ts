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

function loggerErrorSpy(service: WatchdogService): ReturnType<typeof vi.spyOn> {
  const logger = (service as unknown as {
    logger: { error: (message: string) => void };
  }).logger;
  return vi.spyOn(logger, 'error').mockImplementation(() => undefined);
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

  it('keeps booting when the watchdog device cannot be opened', async () => {
    process.env.WATCHDOG_PET_INTERVAL_MS = '15000';
    vi.useFakeTimers();
    const watchdog = fakeWatchdog();
    watchdog.open.mockRejectedValue(Object.assign(
      new Error("EACCES: permission denied, open '/dev/watchdog'"),
      { code: 'EACCES' },
    ));
    const service = new WatchdogService(true, watchdog);
    const error = loggerErrorSpy(service);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(45000);
    expect(watchdog.pet).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Hardware watchdog inactive: EACCES');
    const logged = error.mock.calls.flat().join(' ');
    expect(logged).not.toContain('/dev/watchdog');
    expect(logged).not.toContain('permission denied');
  });

  it('does not disarm a watchdog device that never opened', async () => {
    const watchdog = fakeWatchdog();
    watchdog.open.mockRejectedValue(Object.assign(new Error('device busy'), { code: 'EBUSY' }));
    const service = new WatchdogService(true, watchdog);
    loggerErrorSpy(service);

    await service.onApplicationBootstrap();

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(watchdog.close).not.toHaveBeenCalled();
  });

  it('names the error class when the open failure carries no code', async () => {
    class WatchdogDeviceError extends Error {
      override readonly name = 'WatchdogDeviceError';
    }
    const watchdog = fakeWatchdog();
    watchdog.open.mockRejectedValue(new WatchdogDeviceError('no such device'));
    const service = new WatchdogService(true, watchdog);
    const error = loggerErrorSpy(service);

    await service.onApplicationBootstrap();

    expect(error).toHaveBeenCalledWith('Hardware watchdog inactive: WatchdogDeviceError');
  });

  it('falls back to a fixed code when the open failure code could carry a path', async () => {
    const watchdog = fakeWatchdog();
    watchdog.open.mockRejectedValue(Object.assign(
      new Error('open failed'),
      { code: "ENOENT: /dev/watchdog0" },
    ));
    const service = new WatchdogService(true, watchdog);
    const error = loggerErrorSpy(service);

    await service.onApplicationBootstrap();

    expect(error).toHaveBeenCalledWith('Hardware watchdog inactive: WATCHDOG_OPERATION_FAILED');
    expect(error.mock.calls.flat().join(' ')).not.toContain('/dev/watchdog0');
  });

  it('logs and survives a watchdog device that will not disarm', async () => {
    const watchdog = fakeWatchdog();
    watchdog.close.mockRejectedValue(Object.assign(
      new Error("EIO: i/o error, write '/dev/watchdog'"),
      { code: 'EIO' },
    ));
    const service = new WatchdogService(true, watchdog);
    const error = loggerErrorSpy(service);

    await service.onApplicationBootstrap();

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Hardware watchdog disarm failed: EIO');
    expect(error.mock.calls.flat().join(' ')).not.toContain('/dev/watchdog');
  });

  it('does not disarm when destroyed before bootstrap', async () => {
    const watchdog = fakeWatchdog();
    const service = new WatchdogService(true, watchdog);

    await service.onModuleDestroy();

    expect(watchdog.close).not.toHaveBeenCalled();
  });

  it('disarms once across repeated destroys', async () => {
    const watchdog = fakeWatchdog();
    const service = new WatchdogService(true, watchdog);

    await service.onApplicationBootstrap();
    await service.onModuleDestroy();
    await service.onModuleDestroy();

    expect(watchdog.close).toHaveBeenCalledTimes(1);
  });
});
