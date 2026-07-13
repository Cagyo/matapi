import { Injectable } from '@nestjs/common';
import type { LiveStreamLease } from '../domain/live-stream.entity';
import type { LiveStreamLeasePort } from '../domain/ports/live-stream-lease.port';

@Injectable()
export class InMemoryLiveStreamLeaseAdapter implements LiveStreamLeasePort {
  private lease: LiveStreamLease | null = null;

  async read(): Promise<LiveStreamLease | null> {
    return this.lease ? structuredClone(this.lease) : null;
  }

  async write(lease: LiveStreamLease): Promise<void> {
    this.lease = structuredClone(lease);
  }

  async clear(): Promise<void> {
    this.lease = null;
  }
}
