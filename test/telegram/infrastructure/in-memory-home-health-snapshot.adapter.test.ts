import { describe, expect, it } from 'vitest';
import { HomeHealthSnapshot } from '../../../src/telegram/domain/home-health-snapshot';
import { InMemoryHomeHealthSnapshotAdapter } from '../../../src/telegram/infrastructure/in-memory-home-health-snapshot.adapter';

function snapshot(completedAt = new Date('2030-01-01T00:00:00.000Z')): HomeHealthSnapshot {
  return {
    completedAt,
    enabledSensorIds: ['door'],
    onlineSensorIds: ['door'],
    missingSensorIds: [],
    failedSensorIds: [],
    timedOutSensorIds: [],
    offlineSensorIds: [],
  };
}

describe('InMemoryHomeHealthSnapshotAdapter', () => {
  it('keeps only the latest frozen snapshot', () => {
    const adapter = new InMemoryHomeHealthSnapshotAdapter();
    const first = snapshot();
    const latest = snapshot(new Date('2030-01-01T00:01:00.000Z'));

    adapter.set(first);
    adapter.set(latest);

    expect(adapter.get()).toBe(latest);
    expect(Object.isFrozen(adapter.get())).toBe(true);
    expect(Object.isFrozen(adapter.get()?.onlineSensorIds)).toBe(true);
  });
});
