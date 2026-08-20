import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { BootRecoveryService } from '../../../src/system/application/boot-recovery.service';
import { DatabaseRecoveryState } from '../../../src/database/database-recovery.state';
import { ClockSyncProbePort } from '../../../src/system/domain/ports/clock-sync.port';

function makeClock(synchronized: boolean, offsetMs: number | null = null): ClockSyncProbePort {
  return { probe: async () => ({ synchronized, offsetMs }) };
}

/** The EACCES that killed the worker: message and `path` both carry the scan root. */
function scanRootDenied(): Error {
  return Object.assign(
    new Error("EACCES: permission denied, scandir '/home/pi/motion/videos'"),
    { code: 'EACCES', path: '/home/pi/motion/videos' },
  );
}

describe('BootRecoveryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a clean boot with a synchronized clock', async () => {
    const state = new DatabaseRecoveryState();
    const service = new BootRecoveryService(makeClock(true), state);

    const diagnostics = await service.run();

    expect(diagnostics).toEqual({
      dbRecovery: null,
      clockSynchronized: true,
      archiveRecovered: true,
    });
  });

  it('surfaces the recovery outcome recorded by the SQLite factory', async () => {
    const state = new DatabaseRecoveryState();
    state.recovery = 'restored_from_backup';
    const service = new BootRecoveryService(makeClock(false), state);

    const diagnostics = await service.run();

    expect(diagnostics.dbRecovery).toBe('restored_from_backup');
    expect(diagnostics.clockSynchronized).toBe(false);
  });

  it('reports archive recovery as recovered when the registered hook resolves', async () => {
    const service = new BootRecoveryService(makeClock(true), new DatabaseRecoveryState());
    const recover = vi.fn(async () => undefined);
    service.registerArchiveRecovery(recover);

    const diagnostics = await service.run();

    expect(recover).toHaveBeenCalledTimes(1);
    expect(diagnostics.archiveRecovered).toBe(true);
  });

  it('reports recovered when no archive hook is registered, so an archive-less boot stays quiet', async () => {
    const service = new BootRecoveryService(makeClock(true), new DatabaseRecoveryState());

    const diagnostics = await service.run();

    expect(diagnostics.archiveRecovered).toBe(true);
  });

  it('finishes the remaining diagnostics when archive recovery rejects', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const state = new DatabaseRecoveryState();
    state.recovery = 'recreated_empty';
    const probe = vi.fn(async () => ({ synchronized: false, offsetMs: null }));
    const service = new BootRecoveryService({ probe }, state);
    service.registerArchiveRecovery(async () => {
      throw scanRootDenied();
    });

    const diagnostics = await service.run();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual({
      dbRecovery: 'recreated_empty',
      clockSynchronized: false,
      archiveRecovered: false,
    });
  });

  it('logs the contained archive failure without raw error text or a filesystem path', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new BootRecoveryService(makeClock(true), new DatabaseRecoveryState());
    service.registerArchiveRecovery(async () => {
      throw scanRootDenied();
    });

    await service.run();

    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain('ARCHIVE_OPERATION_FAILED');
    expect(line).not.toContain('/home/pi');
    expect(line).not.toContain('permission denied');
    expect(line).not.toContain('scandir');
  });
});
