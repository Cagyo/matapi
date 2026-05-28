export const EVENT_QUEUE_OPTIONS = Symbol('EVENT_QUEUE_OPTIONS');

export interface EventQueueOptions {
  batchSize: number;
  maxQueueBeforeForceAggregate: number;
  drainDelayMs: number;
}