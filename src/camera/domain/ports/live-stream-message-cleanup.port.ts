import type { LiveStreamMessageReference } from '../live-stream.entity';

export const LIVE_STREAM_MESSAGE_CLEANUP = Symbol('LIVE_STREAM_MESSAGE_CLEANUP');

export interface LiveStreamMessageCleanupPort {
  delete(reference: LiveStreamMessageReference): Promise<void>;
}
