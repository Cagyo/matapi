import { describe, expect, it } from 'vitest';
import { ClassifiedSensorState } from '../../../src/sensors/domain/sensor-state-classifier';
import { Sensor } from '../../../src/sensors/domain/sensor';
import { HomeHealthSnapshot, isHomeHealthFresh } from '../../../src/telegram/domain/home-health-snapshot';
import { deriveHomeVerdict } from '../../../src/telegram/application/home-verdict';

const NOW = new Date('2030-01-01T00:00:00.000Z');

function classified(id: string, level: ClassifiedSensorState['level'] = 'normal'): ClassifiedSensorState {
  const sensor: Sensor = {
    id,
    name: id,
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 0,
    severity: 'info',
    lastValue: level === 'unknown' ? null : 'false',
    lastValueAt: null,
  };
  return { sensor, level, active: level === 'normal' ? false : null };
}

function health(overrides: Partial<HomeHealthSnapshot> = {}): HomeHealthSnapshot {
  return {
    completedAt: NOW,
    enabledSensorIds: ['a'],
    onlineSensorIds: ['a'],
    missingSensorIds: [],
    failedSensorIds: [],
    timedOutSensorIds: [],
    offlineSensorIds: [],
    ...overrides,
  };
}

describe('deriveHomeVerdict', () => {
  it.each([
    ['a current snapshot', NOW, true],
    ['a snapshot just inside the freshness window', new Date(NOW.getTime() - 119_999), true],
    ['a snapshot exactly at the freshness boundary', new Date(NOW.getTime() - 120_000), false],
    ['a future snapshot', new Date(NOW.getTime() + 1), false],
    ['an invalid snapshot date', new Date('invalid'), false],
  ])('marks %s as fresh=%s', (_case, completedAt, expected) => {
    expect(isHomeHealthFresh(completedAt, NOW)).toBe(expected);
  });

  it.each([
    ['zero enabled sensors', [], null, 'unavailable'],
    ['unknown sensor state', [classified('a', 'unknown')], health(), 'unavailable'],
    ['absent health snapshot', [classified('a')], null, 'unavailable'],
    ['health exactly two minutes old', [classified('a')], health({ completedAt: new Date(NOW.getTime() - 120_000) }), 'unavailable'],
    ['future health snapshot', [classified('a')], health({ completedAt: new Date(NOW.getTime() + 1) }), 'unavailable'],
    ['enabled id mismatch', [classified('a')], health({ enabledSensorIds: ['b'] }), 'unavailable'],
    ['missing health result', [classified('a')], health({ missingSensorIds: ['a'] }), 'unavailable'],
    ['failed health result', [classified('a')], health({ failedSensorIds: ['a'] }), 'unavailable'],
    ['timed-out health result', [classified('a')], health({ timedOutSensorIds: ['a'] }), 'unavailable'],
    ['offline health result', [classified('a')], health({ offlineSensorIds: ['a'] }), 'unavailable'],
    ['incomplete online health result', [classified('a')], health({ onlineSensorIds: [] }), 'unavailable'],
    ['fresh complete all-online health', [classified('a')], health(), 'normal'],
  ] as const)('returns %s as %s', (_case, sensors, snapshot, expected) => {
    expect(deriveHomeVerdict({ sensors, health: snapshot, now: NOW })).toBe(expected);
  });

  it('returns attention before unavailable for every mixed health case', () => {
    for (const snapshot of [
      null,
      health({ completedAt: new Date(NOW.getTime() - 120_000) }),
      health({ completedAt: new Date(NOW.getTime() + 1) }),
      health({ enabledSensorIds: ['other'] }),
      health({ missingSensorIds: ['a'] }),
      health({ failedSensorIds: ['a'] }),
      health({ timedOutSensorIds: ['a'] }),
      health({ offlineSensorIds: ['a'] }),
    ]) {
      expect(deriveHomeVerdict({ sensors: [classified('a', 'warning')], health: snapshot, now: NOW })).toBe('attention');
    }
  });

  it('compares duplicate and reordered enabled IDs as sorted unique sets', () => {
    expect(deriveHomeVerdict({
      sensors: [classified('b'), classified('a'), classified('a')],
      health: health({ enabledSensorIds: ['a', 'b', 'b'], onlineSensorIds: ['a', 'b'] }),
      now: NOW,
    })).toBe('normal');
  });
});
