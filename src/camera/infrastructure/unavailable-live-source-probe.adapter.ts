import { LiveSourceProbeFailedError } from '../domain/errors/live-source-probe-failed.error';
import type { LiveSource } from '../domain/live-source.entity';
import type { LiveSourceProbePort } from '../domain/ports/live-source-probe.port';

export class UnavailableLiveSourceProbeAdapter implements LiveSourceProbePort {
  async run(_source: LiveSource): Promise<void> {
    throw new LiveSourceProbeFailedError();
  }
}
