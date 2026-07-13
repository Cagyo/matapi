import type {
  LiveStreamProcessId,
  LiveStreamSession,
  LiveStreamSource,
  LiveStreamViewer,
} from '../live-stream.entity';

export const LIVE_STREAM_GATEWAY = Symbol('LIVE_STREAM_GATEWAY');

export interface LiveStreamGatewayPort {
  /** Reports terminal data-plane failure to the session owner. */
  onFailure?(handler: () => void): void;
  start(input: { session: LiveStreamSession; source: LiveStreamSource }): Promise<{
    publicHostname: string;
    pid: LiveStreamProcessId;
    processIdentity: string;
  }>;
  addViewer(viewer: LiveStreamViewer): Promise<void>;
  revokeViewer(tokenHash: string): Promise<void>;
  stop(): Promise<void>;
  recoverOwnedProcess(input: {
    sessionId: string;
    sourceKind: LiveStreamSource['kind'];
    pid: LiveStreamProcessId;
    processIdentity: string;
  }): Promise<'stopped' | 'not-owned'>;
}
