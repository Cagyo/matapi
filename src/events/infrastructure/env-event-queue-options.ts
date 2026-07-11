import { DefaultsConfig } from '../../config/config.loader';
import { EventQueueOptions } from '../application/ports/event-queue-options.port';

const DEFAULT_MAX_UNSENT_EVENTS = 500;
const DEFAULT_BATCH_SIZE = 50;

export function eventQueueOptionsFromEnv(
  defaults: DefaultsConfig['notifications'],
  env: NodeJS.ProcessEnv = process.env,
): EventQueueOptions {
  const maxUnsentEvents = positiveIntegerFromEnv(
    env.EVENT_MAX_UNSENT,
    DEFAULT_MAX_UNSENT_EVENTS,
  );

  return {
    batchSize: DEFAULT_BATCH_SIZE,
    maxUnsentEvents,
    maxQueueBeforeForceAggregate: Math.min(
      positiveIntegerFromEnv(
        env.MAX_QUEUE_BEFORE_FORCE_AGGREGATE,
        defaults.max_queue_before_force_aggregate,
      ),
      maxUnsentEvents,
    ),
  };
}

function positiveIntegerFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
