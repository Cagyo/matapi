import { describe, expect, it, vi } from 'vitest';
import { prepareApplicationShutdown } from '../../../src/prepare-application-shutdown';
import { LiveStreamSessionService } from '../../../src/camera/application/live-stream-session.service';
import { GracefulShutdownService } from '../../../src/system/application/graceful-shutdown.service';

describe('prepareApplicationShutdown', () => {
  it('stops live streaming while Telegram cleanup is still registered', async () => {
    const order: string[] = [];
    const liveStreams = { shutdown: vi.fn(async () => { order.push('live-stream'); }) };
    const graceful = { run: vi.fn(async () => { order.push('events-and-notice'); }) };
    const app = {
      get(token: unknown) {
        if (token === LiveStreamSessionService) return liveStreams;
        if (token === GracefulShutdownService) return graceful;
        throw new Error('unexpected token');
      },
    };

    await prepareApplicationShutdown(app, 'SIGTERM');
    order.push('telegram-seam-clear');

    expect(order).toEqual(['live-stream', 'events-and-notice', 'telegram-seam-clear']);
  });
});
