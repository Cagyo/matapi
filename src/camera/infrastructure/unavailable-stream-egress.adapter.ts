import { LiveSourceProbeFailedError } from '../domain/errors/live-source-probe-failed.error';
import type {
  StreamEgressLease,
  StreamEgressPort,
} from '../domain/ports/stream-egress.port';
import type { StreamEgressGrant } from '../domain/stream-egress-grant.value-object';

/** Task 2 fail-closed binding; Task 3 replaces this with the nft adapter. */
export class UnavailableStreamEgressAdapter implements StreamEgressPort {
  async grant(_request: StreamEgressGrant): Promise<StreamEgressLease> {
    throw new LiveSourceProbeFailedError();
  }

  async revoke(_lease: StreamEgressLease): Promise<void> {
    throw new LiveSourceProbeFailedError();
  }
}
