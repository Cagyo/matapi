import { describe, expect, it } from 'vitest';
import { GpioPin } from '../../../src/sensors/domain/gpio-pin.value-object';
import { InvalidGpioPinError } from '../../../src/sensors/domain/errors/invalid-gpio-pin.error';

describe('GpioPin', () => {
  it('accepts integers in 0–27', () => {
    expect(new GpioPin(0).value).toBe(0);
    expect(new GpioPin(17).value).toBe(17);
    expect(new GpioPin(27).value).toBe(27);
  });

  it.each([-1, 28, 99, 1.5, NaN])('rejects %p', (bad) => {
    expect(() => new GpioPin(bad)).toThrow(InvalidGpioPinError);
  });

  it('compares by value', () => {
    expect(new GpioPin(5).equals(new GpioPin(5))).toBe(true);
    expect(new GpioPin(5).equals(new GpioPin(6))).toBe(false);
  });
});
