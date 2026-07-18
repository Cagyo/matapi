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
  etag?: string | null;
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
  | "archive-integrity"
  | "disk-resource"
  | "maintenance-required";

export type ReleaseFeedTransportFailure =
  | {
      code: "http-status";
      reason: "response-status" | "unconditional-not-modified";
    }
  | {
      code: Exclude<ReleaseFeedTransportFailureCode, "http-status">;
    };

export class ReleaseFeedTransportError extends Error {
  readonly code: ReleaseFeedTransportFailureCode;

  constructor(readonly failure: ReleaseFeedTransportFailure) {
    super(failure.code);
    this.name = "ReleaseFeedTransportError";
    this.code = failure.code;
  }
}

export interface ReleaseFeedTransportPort {
  fetchEnvelope(request: FetchEnvelopeRequest): Promise<FetchEnvelopeResult>;
  downloadArtifact(
    request: DownloadArtifactRequest,
  ): Promise<DownloadArtifactResult>;
}
