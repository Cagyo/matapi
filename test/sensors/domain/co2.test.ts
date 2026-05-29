import { describe, expect, it } from 'vitest';
import { classifyCo2, isValidPpm } from '../../../src/sensors/domain/co2';

describe('co2 domain', () => {
  const thresholds = { warning: 800, critical: 1200 };

  describe('classifyCo2', () => {
    it('returns normal below warning', () => {
      expect(classifyCo2(500, thresholds)).toBe('normal');
      expect(classifyCo2(799, thresholds)).toBe('normal');
    });

    it('returns warning between warning and critical', () => {
      expect(classifyCo2(800, thresholds)).toBe('warning');
      expect(classifyCo2(1199, thresholds)).toBe('warning');
    });

    it('returns critical at or above critical', () => {
      expect(classifyCo2(1200, thresholds)).toBe('critical');
      expect(classifyCo2(2500, thresholds)).toBe('critical');
    });
  });

  describe('isValidPpm', () => {
    it.each([0, 400, 5000])('accepts %p', (ppm) => expect(isValidPpm(ppm)).toBe(true));
    it.each([null, undefined, -1, 5001, NaN, Infinity])('rejects %p', (ppm) =>
      expect(isValidPpm(ppm)).toBe(false),
    );
  });
});
