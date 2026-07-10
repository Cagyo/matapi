import { describe, expect, it } from 'vitest';
import { eventProcessorOptionsFromEnv } from '../../../src/events/infrastructure/env-event-processor-options';

describe('eventProcessorOptionsFromEnv', () => {
  it.each([
    ['missing', {}],
    ['zero', { EVENT_MAX_CONCURRENCY: '0', EVENT_MAX_PENDING: '0' }],
    ['negative', { EVENT_MAX_CONCURRENCY: '-1', EVENT_MAX_PENDING: '-1' }],
    ['fractional', { EVENT_MAX_CONCURRENCY: '1.5', EVENT_MAX_PENDING: '1.5' }],
    ['NaN', { EVENT_MAX_CONCURRENCY: 'NaN', EVENT_MAX_PENDING: 'NaN' }],
  ])('falls back to defaults when values are %s', (_case, env) => {
    expect(eventProcessorOptionsFromEnv(env)).toEqual({
      maxConcurrent: 4,
      maxPendingEvents: 500,
    });
  });

  it('accepts positive integer environment values', () => {
    expect(
      eventProcessorOptionsFromEnv({
        EVENT_MAX_CONCURRENCY: '3',
        EVENT_MAX_PENDING: '250',
      }),
    ).toEqual({ maxConcurrent: 3, maxPendingEvents: 250 });
  });
});
