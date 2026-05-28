import { describe, expect, it } from 'vitest';
import { OsSystemHealthAdapter } from '../../../src/system/infrastructure/os-system-health.adapter';

describe('OsSystemHealthAdapter', () => {
  const adapter = new OsSystemHealthAdapter();

  it('returns a snapshot with finite memory + uptime, even on dev hosts', async () => {
    const snap = await adapter.collect();

    expect(snap.memoryUsedBytes).toBeGreaterThan(0);
    expect(snap.memoryTotalBytes).toBeGreaterThan(0);
    expect(snap.uptimeSec).toBeGreaterThanOrEqual(0);
    // CPU temp / db size / disk are platform-dependent — they may be null
    // on macOS dev boxes; the contract only requires they don't throw.
    expect(snap).toHaveProperty('cpuTempC');
    expect(snap).toHaveProperty('dbSizeBytes');
    expect(snap).toHaveProperty('diskTotalBytes');
  });
});
