import {
  LiveSource,
  type LiveSourceProfileSettings,
  type LiveSourceSecuritySettings,
  type LiveSourceTransportSettings,
} from './live-source.entity';

/** The endpoint an operator supplies, before it is bound to a camera. */
export interface LiveSourceEndpointInput {
  url: string;
  transport: LiveSourceTransportSettings['transport'];
  tlsMode: LiveSourceSecuritySettings['tlsMode'];
  profile: LiveSourceProfileSettings['profile'];
  substream?: string | null;
}

/**
 * Builds the probe-ready source every RTSP mutation shares. Ready by
 * construction: nothing reaches persistence without first passing a probe, so a
 * source built here is either verified or discarded.
 */
export function liveSourceFrom(
  cameraId: string,
  input: LiveSourceEndpointInput,
): LiveSource {
  return LiveSource.create({
    cameraId,
    url: input.url,
    transport: input.transport,
    tlsMode: input.tlsMode,
    profile: input.profile,
    substream: input.substream,
    ready: true,
  });
}
