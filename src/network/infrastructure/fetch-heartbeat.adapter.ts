import { Injectable, Logger } from '@nestjs/common';
import { HeartbeatClientPort } from '../domain/ports/heartbeat-client.port';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * `HeartbeatClientPort` over the global `fetch`. Reads `HEARTBEAT_URL` at call
 * time so an empty value is a clean no-op (spec 22). A 10s `AbortSignal`
 * timeout prevents a hung request from stacking up behind the interval.
 */
@Injectable()
export class FetchHeartbeatAdapter implements HeartbeatClientPort {
  private readonly logger = new Logger(FetchHeartbeatAdapter.name);

  async pingExternal(): Promise<void> {
    const url = process.env.HEARTBEAT_URL;
    if (!url) return;

    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      this.logger.debug(`Heartbeat returned HTTP ${res.status}`);
    }
  }
}
