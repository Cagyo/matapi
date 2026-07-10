import { EventProcessorOptions } from '../application/ports/event-processor-options.port';

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_PENDING_EVENTS = 500;

export function eventProcessorOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EventProcessorOptions {
  return {
    maxConcurrent: positiveIntegerFromEnv(env.EVENT_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENT),
    maxPendingEvents: positiveIntegerFromEnv(env.EVENT_MAX_PENDING, DEFAULT_MAX_PENDING_EVENTS),
  };
}

function positiveIntegerFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
