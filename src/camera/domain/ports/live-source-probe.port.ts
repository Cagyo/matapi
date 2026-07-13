import type { LiveSource } from '../live-source.entity';

export const LIVE_SOURCE_PROBE = Symbol('LIVE_SOURCE_PROBE');

export interface LiveSourceProbePort {
  run(source: LiveSource): Promise<void>;
}
