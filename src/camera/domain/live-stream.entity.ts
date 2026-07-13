const VIEWER_TOKEN_MINIMUM_BYTES = 32;

declare const liveStreamProcessIdBrand: unique symbol;

/**
 * Opaque identifier of the worker-owned streaming process. This is a numeric
 * recovery handle only; it does not expose or depend on a process API.
 */
export type LiveStreamProcessId = number & {
  readonly [liveStreamProcessIdBrand]: 'LiveStreamProcessId';
};

export interface MotionMjpegLiveStreamSource {
  kind: 'motion-mjpeg';
  cameraId: string;
  cameraName: string;
  upstreamUrl: string;
}

export interface RtspLiveStreamSource {
  kind: 'rtsp';
  cameraId: string;
  cameraName: string;
}

export type LiveStreamSource = MotionMjpegLiveStreamSource | RtspLiveStreamSource;

export interface LiveStreamViewer {
  tokenHash: string;
  telegramId: number;
  expiresMonotonicMs: number;
}

export interface LiveStreamSession {
  id: string;
  cameraId: string;
  cameraName: string;
  startedMonotonicMs: number;
  durationMs: number;
  expiresMonotonicMs: number;
}

export interface CreateLiveStreamSessionInput {
  id: string;
  cameraId: string;
  cameraName: string;
  startedMonotonicMs: number;
  durationMs: number;
}

export interface LiveStreamMessageReference {
  telegramId: number;
  chatId: number;
  messageId: number;
}

export type NewLiveStreamMessageReference = Omit<
  LiveStreamMessageReference,
  'telegramId'
>;

/**
 * Runtime-only recovery data. Its wall-clock expiry is diagnostic only: a
 * process is never restored after a worker restart.
 */
export interface LiveStreamLease {
  sessionNonce: string;
  pid: LiveStreamProcessId;
  processIdentity: string;
  cameraId: string;
  /** Optional for backward compatibility; missing historical leases are Motion. */
  sourceKind?: LiveStreamSource['kind'];
  diagnosticExpiresAtUnixMs: number;
  messageReferences: LiveStreamMessageReference[];
}

export function createLiveStreamSession(
  input: CreateLiveStreamSessionInput,
): LiveStreamSession {
  return {
    ...input,
    expiresMonotonicMs: input.startedMonotonicMs + input.durationMs,
  };
}

export function createLiveStreamProcessId(
  pid: number,
): LiveStreamProcessId {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError(
      'Live stream recovery process identifier must be a positive safe integer',
    );
  }

  return pid as LiveStreamProcessId;
}

/**
 * Encodes caller-provided cryptographic entropy for a one-time viewer URL.
 * Callers must hash the returned token before it enters a viewer or lease.
 */
export function createViewerToken(secret: Uint8Array): string {
  if (secret.byteLength < VIEWER_TOKEN_MINIMUM_BYTES) {
    throw new RangeError(
      `Viewer token secret must contain at least ${VIEWER_TOKEN_MINIMUM_BYTES} bytes`,
    );
  }

  return Buffer.from(secret).toString('base64url');
}
