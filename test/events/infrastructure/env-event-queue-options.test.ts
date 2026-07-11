import { describe, expect, it } from 'vitest';
import { DefaultsConfig } from '../../../src/config/config.loader';
import { eventQueueOptionsFromEnv } from '../../../src/events/infrastructure/env-event-queue-options';

const defaults: DefaultsConfig['notifications'] = {
  quiet_hours_default: null,
  critical_ignores_quiet_hours: true,
  max_queue_before_force_aggregate: 100,
};

describe('eventQueueOptionsFromEnv', () => {
  it('uses EVENT_MAX_UNSENT and clamps the aggregation threshold to it', () => {
    expect(
      eventQueueOptionsFromEnv(defaults, {
        EVENT_MAX_UNSENT: '3',
        MAX_QUEUE_BEFORE_FORCE_AGGREGATE: '99',
      }),
    ).toEqual({
      batchSize: 50,
      maxUnsentEvents: 3,
      maxQueueBeforeForceAggregate: 3,
    });
  });

  it.each([
    ['missing', {}],
    ['invalid', { EVENT_MAX_UNSENT: 'many', MAX_QUEUE_BEFORE_FORCE_AGGREGATE: 'bad' }],
    ['zero', { EVENT_MAX_UNSENT: '0', MAX_QUEUE_BEFORE_FORCE_AGGREGATE: '0' }],
  ])('falls back to safe defaults when values are %s', (_case, env) => {
    expect(eventQueueOptionsFromEnv(defaults, env)).toEqual({
      batchSize: 50,
      maxUnsentEvents: 500,
      maxQueueBeforeForceAggregate: 100,
    });
  });
});
