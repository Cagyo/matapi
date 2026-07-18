import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat as nodeLstat,
  open,
  unlink as nodeUnlink,
  type FileHandle,
} from "node:fs/promises";
import {
  ReleaseFeedTransportError,
  type DownloadArtifactRequest,
  type DownloadArtifactResult,
  type FetchEnvelopeRequest,
  type FetchEnvelopeResult,
  type ReleaseFeedTimeouts,
  type ReleaseFeedTransportPort,
} from "../domain/ports/release-feed-transport.port";

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export interface NodeReleaseFeedTransportOptions {
  /** Test-only escape hatch. Production construction must keep this disabled. */
  allowInsecureLoopback?: boolean;
  /** Test seam for deterministic transport failures and terminal races. */
  fetch?: typeof globalThis.fetch;
  /** Test seam for deterministic local cleanup and writer failures. */
  fileSystem?: ReleaseFeedFileSystem;
}

export interface ReleaseArtifactWriter {
  chmodPrivate(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
  destroy?(): void | Promise<void>;
}

export interface ReleaseFeedFileSystem {
  openExclusive(path: string): Promise<ReleaseArtifactWriter>;
  unlink(path: string): Promise<void>;
  lstat(path: string): Promise<unknown>;
}

type AbortReason = "caller" | "timeout" | null;

interface OperationState {
  controller: AbortController;
  reason: AbortReason;
  abortForTimeout(): void;
  finish(): void;
}

class LocalResourceError extends Error {
  constructor() {
    super("disk-resource");
    this.name = "LocalResourceError";
  }
}

function transportError(
  code: ConstructorParameters<typeof ReleaseFeedTransportError>[0],
): ReleaseFeedTransportError {
  return new ReleaseFeedTransportError(code);
}

function callerAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

async function localResource<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new LocalResourceError();
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${label} must be a positive safe integer`);
}

function validateTimeouts(timeouts: ReleaseFeedTimeouts): void {
  assertPositiveSafeInteger(timeouts.connectMs, "connectMs");
  assertPositiveSafeInteger(timeouts.firstByteMs, "firstByteMs");
  assertPositiveSafeInteger(timeouts.idleMs, "idleMs");
  assertPositiveSafeInteger(timeouts.totalMs, "totalMs");
}

function startOperation(
  timeouts: ReleaseFeedTimeouts,
  signal?: AbortSignal,
): OperationState {
  validateTimeouts(timeouts);
  const controller = new AbortController();
  let reason: AbortReason = null;

  const abortForTimeout = (): void => {
    if (reason !== null) return;
    reason = "timeout";
    controller.abort();
  };
  const abortForCaller = (): void => {
    if (reason !== null) return;
    reason = "caller";
    controller.abort();
  };

  if (signal?.aborted) abortForCaller();
  else signal?.addEventListener("abort", abortForCaller, { once: true });

  const totalTimer = setTimeout(abortForTimeout, timeouts.totalMs);
  totalTimer.unref();

  return {
    controller,
    get reason() {
      return reason;
    },
    abortForTimeout,
    finish(): void {
      clearTimeout(totalTimer);
      signal?.removeEventListener("abort", abortForCaller);
    },
  };
}

function throwAbort(state: OperationState): never {
  if (state.reason === "caller") throw callerAbortError();
  throw transportError("network-timeout");
}

async function withStageTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  state: OperationState,
): Promise<T> {
  const timer = setTimeout(() => state.abortForTimeout(), timeoutMs);
  timer.unref();
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
  }
}

function contentLength(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (header === null) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(header))
    throw transportError("archive-integrity");
  const parsed = Number(header);
  if (!Number.isSafeInteger(parsed)) throw transportError("archive-integrity");
  return parsed;
}

function assertIdentityEncoding(response: Response): void {
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity")
    throw transportError("archive-integrity");
}

function isStrongEtag(value: string | null): value is string {
  if (value === null || value.length < 2) return false;
  if (!value.startsWith('"') || !value.endsWith('"')) return false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index);
    const isEtagCharacter =
      code === 0x21 ||
      (code >= 0x23 && code <= 0x5b) ||
      (code >= 0x5d && code <= 0x7e) ||
      (code >= 0x80 && code <= 0xff);
    if (!isEtagCharacter) return false;
  }
  return true;
}

async function cancelResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function cancelReaderAndResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  response: Response,
): Promise<void> {
  const cancellations: Promise<unknown>[] = [reader.cancel()];
  if (response.body !== null) cancellations.push(response.body.cancel());
  await Promise.allSettled(cancellations);
}

async function consumeBody(
  response: Response,
  state: OperationState,
  timeouts: ReleaseFeedTimeouts,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<number> {
  if (response.body === null) return 0;
  const body = response.body as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  let size = 0;
  let firstRead = true;
  try {
    while (true) {
      const timeoutMs = firstRead ? timeouts.firstByteMs : timeouts.idleMs;
      const result = await withStageTimeout(
        async () => {
          try {
            return await reader.read();
          } catch {
            if (state.reason !== null) throwAbort(state);
            throw transportError("network-unavailable");
          }
        },
        timeoutMs,
        state,
      );
      if (state.reason !== null) throwAbort(state);
      if (result.done) break;
      firstRead = false;
      size += result.value.byteLength;
      await onChunk(result.value);
      if (state.reason !== null) throwAbort(state);
    }
    return size;
  } catch (error) {
    await cancelReaderAndResponse(reader, response);
    if (state.reason !== null) throwAbort(state);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function writeFully(file: FileHandle, bytes: Uint8Array): Promise<void> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await file.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (bytesWritten === 0) throw new Error("artifact write made no progress");
    offset += bytesWritten;
  }
}

const NODE_RELEASE_FEED_FILE_SYSTEM: ReleaseFeedFileSystem = {
  async openExclusive(path): Promise<ReleaseArtifactWriter> {
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    return {
      chmodPrivate: () => file.chmod(0o600),
      write: (bytes) => writeFully(file, bytes),
      sync: () => file.sync(),
      close: () => file.close(),
      destroy: () => file.close(),
    };
  },
  unlink: (path) => nodeUnlink(path),
  lstat: (path) => nodeLstat(path),
};

async function pathnameIsAbsent(
  fileSystem: ReleaseFeedFileSystem,
  destination: string,
): Promise<boolean> {
  try {
    await fileSystem.lstat(destination);
    return false;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

async function cleanupPartialArtifact(
  fileSystem: ReleaseFeedFileSystem,
  destination: string,
  writer: ReleaseArtifactWriter,
): Promise<boolean> {
  try {
    await writer.close();
  } catch {
    // Pathname absence, checked below, is the authoritative cleanup proof.
  }
  try {
    await writer.destroy?.();
  } catch {
    // A second close failure does not matter if pathname absence is proven.
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fileSystem.unlink(destination);
    } catch {
      // ENOENT and unlink failures are both resolved by the no-follow lstat.
    }
    if (await pathnameIsAbsent(fileSystem, destination)) return true;
  }
  return false;
}

export class NodeReleaseFeedTransportAdapter implements ReleaseFeedTransportPort {
  constructor(private readonly options: NodeReleaseFeedTransportOptions = {}) {}

  async fetchEnvelope(
    request: FetchEnvelopeRequest,
  ): Promise<FetchEnvelopeResult> {
    assertPositiveSafeInteger(request.maxBytes, "maxBytes");
    const state = startOperation(request.timeouts, request.signal);
    try {
      const headers: Record<string, string> = {
        "accept-encoding": "identity",
      };
      if (request.etag !== undefined) headers["if-none-match"] = request.etag;
      const response = await this.fetchWithRedirects(
        request.url,
        headers,
        state,
        request.timeouts.connectMs,
      );

      if (response.status === 304) {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        if (request.etag === undefined) throw transportError("http-status");
        return { kind: "not-modified" };
      }
      if (response.status === 206) {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        throw transportError("archive-integrity");
      }
      if (response.status !== 200) {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        throw transportError("http-status");
      }

      try {
        assertIdentityEncoding(response);
        const etag = response.headers.get("etag");
        if (!isStrongEtag(etag)) throw transportError("archive-integrity");
        const declaredLength = contentLength(response);
        if (declaredLength !== undefined && declaredLength > request.maxBytes) {
          throw transportError("envelope-too-large");
        }

        const chunks: Buffer[] = [];
        let receivedSize = 0;
        await consumeBody(response, state, request.timeouts, (chunk) => {
          receivedSize += chunk.byteLength;
          if (receivedSize > request.maxBytes)
            throw transportError("envelope-too-large");
          chunks.push(Buffer.from(chunk));
        });
        if (state.reason !== null) throwAbort(state);
        return { kind: "ok", bytes: Buffer.concat(chunks), etag };
      } catch (error) {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        throw error;
      }
    } finally {
      state.finish();
    }
  }

  async downloadArtifact(
    request: DownloadArtifactRequest,
  ): Promise<DownloadArtifactResult> {
    assertPositiveSafeInteger(request.expectedSize, "expectedSize");
    assertPositiveSafeInteger(request.maxBytes, "maxBytes");
    if (request.expectedSize > request.maxBytes)
      throw transportError("archive-integrity");

    const state = startOperation(request.timeouts, request.signal);
    const fileSystem = this.options.fileSystem ?? NODE_RELEASE_FEED_FILE_SYSTEM;
    let writer: ReleaseArtifactWriter | undefined;
    let createdDestination = false;
    let response: Response | undefined;
    try {
      response = await this.fetchWithRedirects(
        request.url,
        { "accept-encoding": "identity" },
        state,
        request.timeouts.connectMs,
      );
      if (response.status === 206) {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        throw transportError("archive-integrity");
      }
      if (response.status !== 200) {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        throw transportError("http-status");
      }

      try {
        assertIdentityEncoding(response);
        const declaredLength = contentLength(response);
        if (
          declaredLength !== undefined &&
          (declaredLength !== request.expectedSize ||
            declaredLength > request.maxBytes)
        ) {
          throw transportError("archive-integrity");
        }

        try {
          writer = await fileSystem.openExclusive(request.destination);
        } catch (error) {
          if (errorCode(error) === "EEXIST")
            throw transportError("maintenance-required");
          if (!(await pathnameIsAbsent(fileSystem, request.destination)))
            throw transportError("maintenance-required");
          throw new LocalResourceError();
        }
        createdDestination = true;
        await localResource(() => writer!.chmodPrivate());

        const hash = createHash("sha256");
        let receivedSize = 0;
        await consumeBody(response, state, request.timeouts, async (chunk) => {
          receivedSize += chunk.byteLength;
          if (
            receivedSize > request.expectedSize ||
            receivedSize > request.maxBytes
          ) {
            throw transportError("archive-integrity");
          }
          hash.update(chunk);
          await localResource(() => writer!.write(chunk));
        });
        if (receivedSize !== request.expectedSize)
          throw transportError("archive-integrity");

        await localResource(() => writer!.sync());
        if (state.reason !== null) throwAbort(state);
        await localResource(() => writer!.close());
        if (state.reason !== null) throwAbort(state);
        createdDestination = false;
        return {
          size: receivedSize,
          sha256: hash.digest("hex"),
        };
      } catch (error) {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        if (error instanceof LocalResourceError)
          throw transportError("disk-resource");
        throw error;
      }
    } catch (error) {
      await (response === undefined
        ? Promise.resolve()
        : cancelResponse(response));
      let failure: unknown = error;
      if (state.reason !== null) {
        try {
          throwAbort(state);
        } catch (abortFailure) {
          failure = abortFailure;
        }
      } else if (error instanceof LocalResourceError) {
        failure = transportError("disk-resource");
      }

      if (
        createdDestination &&
        writer !== undefined &&
        !(await cleanupPartialArtifact(fileSystem, request.destination, writer))
      ) {
        throw transportError("maintenance-required");
      }
      if (state.reason !== null) throwAbort(state);
      throw failure;
    } finally {
      state.finish();
    }
  }

  private async fetchWithRedirects(
    rawUrl: string,
    headers: Record<string, string>,
    state: OperationState,
    connectTimeoutMs: number,
  ): Promise<Response> {
    if (state.reason !== null) throwAbort(state);
    let current = this.parseAllowedUrl(rawUrl);
    const configuredOrigin = current.origin;
    let redirects = 0;

    while (true) {
      let response: Response;
      try {
        const fetchImplementation = this.options.fetch ?? globalThis.fetch;
        response = await withStageTimeout(
          () =>
            fetchImplementation(current, {
              redirect: "manual",
              headers,
              signal: state.controller.signal,
            }),
          connectTimeoutMs,
          state,
        );
      } catch (error) {
        if (state.reason !== null) throwAbort(state);
        if (error instanceof ReleaseFeedTransportError) throw error;
        throw transportError("network-unavailable");
      }

      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get("location");
      if (location === null || redirects >= MAX_REDIRECTS) {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        throw transportError("redirect-rejected");
      }

      let next: URL;
      try {
        next = this.parseAllowedUrl(new URL(location, current).href);
      } catch {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        throw transportError("redirect-rejected");
      }
      if (next.origin !== configuredOrigin) {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        throw transportError("redirect-rejected");
      }

      await cancelResponse(response);
      if (state.reason !== null) throwAbort(state);
      redirects += 1;
      current = next;
    }
  }

  private parseAllowedUrl(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw transportError("redirect-rejected");
    }
    if (url.username !== "" || url.password !== "" || url.hash !== "")
      throw transportError("redirect-rejected");
    if (url.protocol === "https:") return url;
    if (
      this.options.allowInsecureLoopback === true &&
      url.protocol === "http:" &&
      LOOPBACK_HOSTS.has(url.hostname)
    ) {
      return url;
    }
    throw transportError("redirect-rejected");
  }
}
