const VIEWER_TOKEN_MINIMUM_BYTES = 32;

export interface LiveStreamSource {
  kind: 'motion-mjpeg';
  cameraId: string;
  cameraName: string;
  upstreamUrl: string;
}

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
  chatId: number;
  messageId: number;
}

/**
 * Runtime-only recovery data. Its wall-clock expiry is diagnostic only: a
 * process is never restored after a worker restart.
 */
export interface LiveStreamLease {
  sessionNonce: string;
  pid: number;
  processIdentity: string;
  cameraId: string;
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
