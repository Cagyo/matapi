import { describe, expect, it } from 'vitest';
import { LiveViewStartGate } from '../../../src/camera/application/live-view-start-gate.service';
import { LiveStreamUnavailableError } from '../../../src/camera/domain/errors/live-stream-unavailable.error';

describe('LiveViewStartGate', () => {
  it('fails closed until the current boot or reconciliation explicitly opens it', () => {
    const gate = new LiveViewStartGate();

    expect(() => gate.assertCanStart()).toThrow(LiveStreamUnavailableError);
  });

  it('allows only the newest close epoch to reopen starts', () => {
    const gate = new LiveViewStartGate();
    expect(gate.openIfCurrent(0)).toBe(true);
    expect(() => gate.assertCanStart()).not.toThrow();

    const staleEpoch = gate.close();
    const currentEpoch = gate.close();

    expect(gate.openIfCurrent(staleEpoch)).toBe(false);
    expect(() => gate.assertCanStart()).toThrow(LiveStreamUnavailableError);
    expect(gate.openIfCurrent(currentEpoch)).toBe(true);
    expect(() => gate.assertCanStart()).not.toThrow();
  });
});
