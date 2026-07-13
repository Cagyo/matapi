import { Injectable } from '@nestjs/common';
import {
  createLiveStreamProcessId,
  type LiveStreamViewer,
} from '../domain/live-stream.entity';
import type { LiveStreamGatewayPort } from '../domain/ports/live-stream-gateway.port';

@Injectable()
export class InMemoryLiveStreamGatewayAdapter implements LiveStreamGatewayPort {
  private readonly viewers = new Map<string, LiveStreamViewer>();
  private running = false;

  async start(): ReturnType<LiveStreamGatewayPort['start']> {
    this.running = true;
    return {
      publicHostname: 'local-dev.trycloudflare.com',
      pid: createLiveStreamProcessId(process.pid),
      processIdentity: `in-memory:${process.pid}`,
    };
  }

  async addViewer(viewer: LiveStreamViewer): Promise<void> {
    if (!this.running) throw new Error('Live stream gateway is not running');
    this.viewers.set(viewer.tokenHash, structuredClone(viewer));
  }

  async revokeViewer(tokenHash: string): Promise<void> {
    this.viewers.delete(tokenHash);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.viewers.clear();
  }

  async recoverOwnedProcess(): Promise<'not-owned'> {
    return 'not-owned';
  }
}
