import { describe, expect, it } from 'vitest';
import { isSimulatable } from '../../../src/sensors/domain/ports/simulatable-sensor.port';

describe('isSimulatable', () => {
  it('returns true for an object exposing simulate()', () => {
    expect(isSimulatable({ simulate: () => undefined })).toBe(true);
  });

  it('returns false when simulate is missing or not a function', () => {
    expect(isSimulatable({})).toBe(false);
    expect(isSimulatable({ simulate: 42 })).toBe(false);
  });
});
