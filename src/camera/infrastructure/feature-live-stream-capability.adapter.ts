import { execFile } from 'node:child_process';
import type { FeatureQueryPort } from '../../features/domain/ports/feature-query.port';
import type { LiveStreamCapabilityPort } from '../domain/ports/live-stream-capability.port';
import type { LiveStreamSource } from '../domain/live-stream.entity';

type CloudflaredProbe = () => Promise<boolean>;

/** Requires explicit config, installed/enabled feature state, and the binary. */
export class FeatureLiveStreamCapabilityAdapter implements LiveStreamCapabilityPort {
  constructor(
    private readonly features: FeatureQueryPort,
    private readonly enabled: boolean,
    private readonly probe: CloudflaredProbe = probeCloudflared,
  ) {}

  async isAvailable(sourceKind: LiveStreamSource['kind']): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      if (!(await this.probe())) return false;
      if (sourceKind === 'motion-mjpeg') return true;
      const feature = (await this.features.listAll()).find(({ name }) => name === 'rtsp');
      return Boolean(feature?.installed && feature.enabled);
    } catch {
      return false;
    }
  }
}

function probeCloudflared(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('cloudflared', ['version'], { timeout: 5_000 }, (error) => resolve(!error));
  });
}
