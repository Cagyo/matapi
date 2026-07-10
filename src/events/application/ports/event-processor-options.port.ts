export const EVENT_PROCESSOR_OPTIONS = Symbol('EVENT_PROCESSOR_OPTIONS');

export interface EventProcessorOptions {
  maxConcurrent: number;
  maxPendingEvents: number;
}
