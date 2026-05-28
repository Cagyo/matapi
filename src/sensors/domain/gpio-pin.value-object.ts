import { InvalidGpioPinError } from './errors/invalid-gpio-pin.error';

const MIN_PIN = 0;
const MAX_PIN = 27;

/**
 * Validated GPIO pin number for a Raspberry Pi (BCM numbering, 0–27).
 * Construction throws if the value is outside the legal range; using `value`
 * afterwards is guaranteed safe.
 */
export class GpioPin {
  readonly value: number;

  constructor(value: number) {
    if (!Number.isInteger(value) || value < MIN_PIN || value > MAX_PIN) {
      throw new InvalidGpioPinError(value);
    }
    this.value = value;
  }

  equals(other: GpioPin): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return String(this.value);
  }
}
