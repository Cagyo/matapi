import { describe, expect, it } from 'vitest';
import { summarizeEvents } from '../../../src/events/domain/event-summary';
import { QueuedEvent } from '../../../src/events/domain/queued-event.entity';

function makeEvent(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    id: 1,
    sensorId: 'front_door',
    type: 'state_change',
    payload: { newValue: true, name: 'Front door', severity: 'info' },
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('summarizeEvents', () => {
  it('formats a single sensor event with name and value', () => {
    expect(summarizeEvents([makeEvent()])).toBe(
      '2030-01-01T00:00:00.000Z — Front door true',
    );
  });

  it('falls back to sensor id when payload has no name', () => {
    expect(
      summarizeEvents([
        makeEvent({
          payload: { newValue: true, name: null, severity: 'info' },
        }),
      ]),
    ).toBe('2030-01-01T00:00:00.000Z — front_door true');
  });

  it('falls back to "system" for events without a sensor or name', () => {
    expect(
      summarizeEvents([
        makeEvent({ sensorId: null, type: 'system', payload: null }),
      ]),
    ).toBe('2030-01-01T00:00:00.000Z — system system');
  });

  it('formats multiple events with a date-range header and ⚠️ for warnings', () => {
    expect(
      summarizeEvents([
        makeEvent({ id: 1 }),
        makeEvent({
          id: 2,
          sensorId: 'water_kitchen',
          payload: {
            newValue: 'TRIGGERED',
            name: 'Water kitchen',
            severity: 'critical',
          },
          createdAt: new Date('2030-01-01T01:00:00.000Z'),
        }),
      ]),
    ).toBe(
      '📋 Offline events (2030-01-01T00:00:00.000Z — 2030-01-01T01:00:00.000Z):\n\n' +
        '2030-01-01T00:00:00.000Z — Front door true\n' +
        '2030-01-01T01:00:00.000Z — Water kitchen TRIGGERED ⚠️',
    );
  });

  it('uses a single timestamp in the header when all events share createdAt', () => {
    expect(
      summarizeEvents([makeEvent({ id: 1 }), makeEvent({ id: 2 })]),
    ).toContain('📋 Offline events (2030-01-01T00:00:00.000Z):');
  });
});
