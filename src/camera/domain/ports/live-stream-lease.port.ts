import type { LiveStreamLease } from '../live-stream.entity';

export const LIVE_STREAM_LEASE = Symbol('LIVE_STREAM_LEASE');

export interface LiveStreamLeasePort {
  read(): Promise<LiveStreamLease | null>;
  write(lease: LiveStreamLease): Promise<void>;
  clear(): Promise<void>;
}
