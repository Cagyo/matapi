import { LiveSourceProbeFailedError } from '../domain/errors/live-source-probe-failed.error';
import type { LiveSource } from '../domain/live-source.entity';
import type { LiveSourceProbePort } from '../domain/ports/live-source-probe.port';
import type { RtspRuntimeCoordinatorPort } from '../domain/ports/rtsp-runtime-coordinator.port';

/** Dual fail-closed implementation for the probe and restricted coordinator ports. */
export class UnavailableRtspRuntimeCoordinatorAdapter
implements LiveSourceProbePort, RtspRuntimeCoordinatorPort {
  async run(_source: LiveSource): Promise<never> {
    throw new LiveSourceProbeFailedError();
  }

  async startRestrictedRuntime(): Promise<never> {
    throw new LiveSourceProbeFailedError();
  }

  async recoverRestrictedRuntime(): Promise<never> {
    throw new LiveSourceProbeFailedError();
  }
}
