export const EVENT_QUEUE_OPTIONS = Symbol('EVENT_QUEUE_OPTIONS');

export interface EventQueueOptions {
  /** Max events per drain batch. */
  batchSize: number;
  /** Maximum durable events awaiting notification delivery. */
  maxUnsentEvents: number;
  /**
   * When the unsent queue reaches this size, the drain switches to file
   * delivery to avoid hour-long drip-feeds after extended outages.
   */
  maxQueueBeforeForceAggregate: number;
}
