import type {
  LiveStreamProcessId,
  LiveStreamSession,
  LiveStreamSource,
  LiveStreamViewer,
} from '../live-stream.entity';

export const LIVE_STREAM_GATEWAY = Symbol('LIVE_STREAM_GATEWAY');

export interface LiveStreamGatewayPort {
  start(input: { session: LiveStreamSession; source: LiveStreamSource }): Promise<{
    publicHostname: string;
    pid: LiveStreamProcessId;
    processIdentity: string;
  }>;
  addViewer(viewer: LiveStreamViewer): Promise<void>;
  revokeViewer(tokenHash: string): Promise<void>;
  stop(): Promise<void>;
  recoverOwnedProcess(input: {
    pid: LiveStreamProcessId;
    processIdentity: string;
  }): Promise<'stopped' | 'not-owned'>;
}
