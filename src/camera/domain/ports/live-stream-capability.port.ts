import type { LiveStreamSource } from '../live-stream.entity';

export const LIVE_STREAM_CAPABILITY = Symbol('LIVE_STREAM_CAPABILITY');

/** Deployment/runtime boundary for the opt-in experimental tunnel feature. */
export interface LiveStreamCapabilityPort {
  isAvailable(sourceKind: LiveStreamSource['kind']): Promise<boolean>;
}
