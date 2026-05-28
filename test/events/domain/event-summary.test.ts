import { describe, expect, it } from 'vitest';
import { summarizeEvents } from '../../../src/events/domain/event-summary';
import { QueuedEvent } from '../../../src/events/domain/queued-event.entity';

function makeEvent(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    id: 1,
    sensorId: 'front_door',
    type: 'state_change',
    payload: { newValue: true },
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('summarizeEvents', () => {
  it('formats a single sensor event without a batch header', () => {
    expect(summarizeEvents([makeEvent()])).toBe(
      '2030-01-01T00:00:00.000Z — front_door state_change',
    );
  });

  it('uses system as the fallback sender for events without a sensor id', () => {
    expect(summarizeEvents([makeEvent({ sensorId: null, type: 'system' })])).toBe(
      '2030-01-01T00:00:00.000Z — system system',
    );
  });

  it('formats multiple events as a chronological summary body', () => {
    expect(
      summarizeEvents([
        makeEvent({ id: 1, sensorId: 'front_door' }),
        makeEvent({ id: 2, sensorId: 'back_door', createdAt: null }),
      ]),
    ).toBe(
      '📋 Events (2):\n\n' +
        '2030-01-01T00:00:00.000Z — front_door state_change\n' +
        '— — back_door state_change',
    );
  });
});