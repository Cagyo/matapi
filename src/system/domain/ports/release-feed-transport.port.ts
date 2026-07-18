export const RELEASE_FEED_TRANSPORT = Symbol("RELEASE_FEED_TRANSPORT");

export interface ReleaseFeedTimeouts {
  connectMs: number;
  firstByteMs: number;
  idleMs: number;
  totalMs: number;
}

interface ReleaseFeedRequest {
  url: string;
  maxBytes: number;
  timeouts: ReleaseFeedTimeouts;
  signal?: AbortSignal;
}

export interface FetchEnvelopeRequest extends ReleaseFeedRequest {
  etag?: string;
}

export interface DownloadArtifactRequest extends ReleaseFeedRequest {
  destination: string;
  expectedSize: number;
}

export type FetchEnvelopeResult =
  | { kind: "not-modified" }
  | { kind: "ok"; bytes: Uint8Array; etag: string };

export interface DownloadArtifactResult {
  size: number;
  sha256: string;
}

export type ReleaseFeedTransportFailureCode =
  | "network-unavailable"
  | "network-timeout"
  | "redirect-rejected"
  | "http-status"
  | "envelope-too-large"
  | "archive-integrity";

export class ReleaseFeedTransportError extends Error {
  constructor(readonly code: ReleaseFeedTransportFailureCode) {
    super(code);
    this.name = "ReleaseFeedTransportError";
  }
}

export interface ReleaseFeedTransportPort {
  fetchEnvelope(request: FetchEnvelopeRequest): Promise<FetchEnvelopeResult>;
  downloadArtifact(
    request: DownloadArtifactRequest,
  ): Promise<DownloadArtifactResult>;
}
