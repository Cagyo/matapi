import { describe, expect, it } from 'vitest';
import { BootRecoveryService } from '../../../src/system/application/boot-recovery.service';
import { DatabaseRecoveryState } from '../../../src/database/database-recovery.state';
import { ClockSyncProbePort } from '../../../src/system/domain/ports/clock-sync.port';

function makeClock(synchronized: boolean, offsetMs: number | null = null): ClockSyncProbePort {
  return { probe: async () => ({ synchronized, offsetMs }) };
}

describe('BootRecoveryService', () => {
  it('reports a clean boot with a synchronized clock', async () => {
    const state = new DatabaseRecoveryState();
    const service = new BootRecoveryService(makeClock(true), state);

    const diagnostics = await service.run();

    expect(diagnostics).toEqual({ dbRecovery: null, clockSynchronized: true });
  });

  it('surfaces the recovery outcome recorded by the SQLite factory', async () => {
    const state = new DatabaseRecoveryState();
    state.recovery = 'restored_from_backup';
    const service = new BootRecoveryService(makeClock(false), state);

    const diagnostics = await service.run();

    expect(diagnostics.dbRecovery).toBe('restored_from_backup');
    expect(diagnostics.clockSynchronized).toBe(false);
  });
});
