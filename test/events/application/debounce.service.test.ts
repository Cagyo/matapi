import { describe, expect, it } from 'vitest';
import { DebounceService } from '../../../src/events/application/debounce.service';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';
import { Sensor } from '../../../src/sensors/domain/sensor';
import {
  SensorLookup,
  SensorQueryPort,
} from '../../../src/sensors/domain/ports/sensor-query.port';

function makeSensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: 'front_door',
    name: 'front_door',
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 10_000,
    severity: 'info',
    lastValue: null,
    lastValueAt: null,
    ...overrides,
  };
}

class StubSensorQuery implements SensorQueryPort {
  constructor(private readonly sensor: Sensor | null) {}
  async listEnabled(): Promise<Sensor[]> {
    return this.sensor ? [this.sensor] : [];
  }
  async findById(): Promise<Sensor | null> {
    return this.sensor;
  }
  async findByIdIncludingArchived(): Promise<SensorLookup | null> {
    return this.sensor ? { kind: 'active', sensor: this.sensor } : null;
  }
  async findByName(): Promise<SensorLookup | null> {
    return this.sensor ? { kind: 'active', sensor: this.sensor } : null;
  }
  async listHistoryTargets(input: { page: number; pageSize: number }) {
    return { targets: [], page: input.page, pageCount: 0 };
  }
}

function makeClock(start = 0): ClockPort & { advance(ms: number): void } {
  let current = start;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('DebounceService', () => {
  it('notifies on the first occurrence of a sensor value', async () => {
    const debounce = new DebounceService(new StubSensorQuery(makeSensor()), makeClock());
    expect(await debounce.shouldNotify('front_door', true)).toBe(true);
  });

  it('suppresses an identical value inside the debounce window', async () => {
    const clock = makeClock();
    const debounce = new DebounceService(new StubSensorQuery(makeSensor()), clock);

    expect(await debounce.shouldNotify('front_door', true)).toBe(true);
    clock.advance(5_000);
    expect(await debounce.shouldNotify('front_door', true)).toBe(false);
  });

  it('allows an identical value once the window has elapsed', async () => {
    const clock = makeClock();
    const debounce = new DebounceService(new StubSensorQuery(makeSensor()), clock);

    expect(await debounce.shouldNotify('front_door', true)).toBe(true);
    clock.advance(10_000);
    expect(await debounce.shouldNotify('front_door', true)).toBe(true);
  });

  it('always notifies on a real transition', async () => {
    const clock = makeClock();
    const debounce = new DebounceService(new StubSensorQuery(makeSensor()), clock);

    expect(await debounce.shouldNotify('front_door', true)).toBe(true);
    clock.advance(1_000);
    expect(await debounce.shouldNotify('front_door', false)).toBe(true);
  });

  it('never suppresses when debounce is zero (critical sensors)', async () => {
    const clock = makeClock();
    const debounce = new DebounceService(
      new StubSensorQuery(makeSensor({ debounceMs: 0 })),
      clock,
    );

    expect(await debounce.shouldNotify('front_door', true)).toBe(true);
    expect(await debounce.shouldNotify('front_door', true)).toBe(true);
  });
});
