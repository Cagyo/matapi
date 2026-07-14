import { describe, expect, it } from 'vitest';
import {
  classifySensorState,
  normalizedSensorName,
} from '../../../src/sensors/domain/sensor-state-classifier';
import { Sensor } from '../../../src/sensors/domain/sensor';

function sensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: 'sensor-1',
    name: 'Sensor',
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 100,
    severity: 'warning',
    lastValue: null,
    lastValueAt: null,
    ...overrides,
  };
}

describe('classifySensorState', () => {
  it('marks null values as unknown', () => {
    expect(classifySensorState(sensor())).toMatchObject({ level: 'unknown', active: null });
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ] as const)('recognizes persisted digital value %s', (lastValue, active) => {
    expect(classifySensorState(sensor({ lastValue }))).toMatchObject({
      level: active ? 'warning' : 'normal',
      active,
    });
  });

  it('marks malformed persisted digital values as unknown', () => {
    expect(classifySensorState(sensor({ lastValue: 'opened' }))).toMatchObject({
      level: 'unknown',
      active: null,
    });
  });

  it.each(['warning', 'critical'] as const)(
    'uses %s severity for an active digital sensor',
    (severity) => {
      expect(classifySensorState(sensor({ severity, lastValue: 'true' }))).toMatchObject({
        level: severity,
        active: true,
      });
    },
  );

  it('keeps an active informational digital sensor normal', () => {
    expect(classifySensorState(sensor({ severity: 'info', lastValue: '1' }))).toMatchObject({
      level: 'normal',
      active: true,
    });
  });

  it('classifies persisted UART ppm with configured thresholds', () => {
    const uart = sensor({
      type: 'uart',
      lastValue: '1200.5',
      config: { thresholds: { warning: 800, critical: 1200 } },
    });

    expect(classifySensorState(uart)).toMatchObject({ level: 'critical', active: null });
    expect(classifySensorState({ ...uart, lastValue: '800' })).toMatchObject({ level: 'warning' });
    expect(classifySensorState({ ...uart, lastValue: '799.9' })).toMatchObject({ level: 'normal' });
  });

  it('accepts finite positive thresholds above the valid reading range', () => {
    expect(
      classifySensorState(
        sensor({
          type: 'uart',
          lastValue: '3500',
          config: { thresholds: { warning: 3000, critical: 6000 } },
        }),
      ),
    ).toMatchObject({ level: 'warning', active: null });
  });

  it('accepts canonical scientific notation persisted from a numeric UART reading', () => {
    expect(
      classifySensorState(
        sensor({
          type: 'uart',
          lastValue: '3.5e3',
          config: { thresholds: { warning: 3000, critical: 6000 } },
        }),
      ),
    ).toMatchObject({ level: 'warning', active: null });
  });

  it('marks invalid UART readings unknown', () => {
    expect(
      classifySensorState(sensor({ type: 'uart', lastValue: 'not-a-number' })),
    ).toMatchObject({ level: 'unknown', active: null });
  });

  it('treats a numeric UART value without valid thresholds as normal', () => {
    expect(
      classifySensorState(sensor({ type: 'uart', lastValue: '850', config: {} })),
    ).toMatchObject({ level: 'normal', active: null });
  });

  it.each(['mqtt', 'camera'] as const)('treats a known %s state as normal', (type) => {
    expect(classifySensorState(sensor({ type, lastValue: 'connected' }))).toMatchObject({
      level: 'normal',
      active: null,
    });
  });
});

describe('normalizedSensorName', () => {
  it('applies NFKC, trimming, and lowercase normalization', () => {
    expect(normalizedSensorName('  \u212B\uFF21  ')).toBe('\u00E5a');
  });
});
