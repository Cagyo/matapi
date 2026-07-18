import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link as nodeLink,
  open,
  unlink as nodeUnlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
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
  /** Test seam for a deterministic otherwise-random staging filename token. */
  stagingNameSource?: () => string;
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
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
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
      (code >= 0x23 && code <= 0x7e) ||
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
    };
  },
  link: (existingPath, newPath) => nodeLink(existingPath, newPath),
  unlink: (path) => nodeUnlink(path),
  async fsyncDirectory(path): Promise<void> {
    const directory = await open(path, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  },
};

async function unlinkOwnedStaging(
  fileSystem: ReleaseFeedFileSystem,
  stagingPath: string,
): Promise<boolean> {
  try {
    await fileSystem.unlink(stagingPath);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

function artifactStagingPath(
  destination: string,
  source: () => string,
): string {
  const token = source();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token))
    throw new Error("invalid artifact staging token");
  return resolve(
    dirname(destination),
    `.${basename(destination)}.ota-${token}.partial`,
  );
}

export class NodeReleaseFeedTransportAdapter implements ReleaseFeedTransportPort {
  private artifactWriterPoisoned = false;

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
      if (request.etag != null) headers["if-none-match"] = request.etag;
      const response = await this.fetchWithRedirects(
        request.url,
        headers,
        state,
        request.timeouts.connectMs,
      );

      if (response.status === 304) {
        await cancelResponse(response);
        if (state.reason !== null) throwAbort(state);
        if (request.etag == null) throw transportError("http-status");
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
    if (this.artifactWriterPoisoned)
      throw transportError("maintenance-required");
    assertPositiveSafeInteger(request.expectedSize, "expectedSize");
    assertPositiveSafeInteger(request.maxBytes, "maxBytes");
    if (request.expectedSize > request.maxBytes)
      throw transportError("archive-integrity");

    const destination = resolve(request.destination);
    const parentDirectory = dirname(destination);
    const stagingNameSource =
      this.options.stagingNameSource ?? (() => randomBytes(16).toString("hex"));
    let stagingPath: string;
    try {
      stagingPath = artifactStagingPath(destination, stagingNameSource);
    } catch {
      throw transportError("maintenance-required");
    }

    const state = startOperation(request.timeouts, request.signal);
    const fileSystem = this.options.fileSystem ?? NODE_RELEASE_FEED_FILE_SYSTEM;
    let writer: ReleaseArtifactWriter | undefined;
    let stagingCreated = false;
    let published = false;
    let closeAttempted = false;
    let closeConfirmed = false;
    let response: Response | undefined;

    const confirmWriterClosed = async (): Promise<boolean> => {
      if (writer === undefined) return true;
      if (closeAttempted) return closeConfirmed;
      closeAttempted = true;
      try {
        await writer.close();
        closeConfirmed = true;
      } catch {
        if (writer.destroy !== undefined) {
          try {
            await writer.destroy();
            closeConfirmed = true;
          } catch {
            closeConfirmed = false;
          }
        }
      }
      return closeConfirmed;
    };

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
        writer = await fileSystem.openExclusive(stagingPath);
      } catch (error) {
        if (errorCode(error) === "EEXIST")
          throw transportError("maintenance-required");
        throw new LocalResourceError();
      }
      stagingCreated = true;
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

      const sha256 = hash.digest("hex");
      await localResource(() => writer!.sync());
      if (state.reason !== null) throwAbort(state);
      if (!(await confirmWriterClosed())) {
        this.artifactWriterPoisoned = true;
        throw transportError("maintenance-required");
      }
      if (state.reason !== null) throwAbort(state);

      try {
        await fileSystem.link(stagingPath, destination);
      } catch (error) {
        if (errorCode(error) === "EEXIST")
          throw transportError("maintenance-required");
        throw new LocalResourceError();
      }
      published = true;

      try {
        await fileSystem.fsyncDirectory(parentDirectory);
      } catch {
        throw transportError("maintenance-required");
      }
      try {
        await fileSystem.unlink(stagingPath);
        stagingCreated = false;
      } catch (error) {
        if (errorCode(error) === "ENOENT") stagingCreated = false;
        else throw transportError("maintenance-required");
      }
      try {
        await fileSystem.fsyncDirectory(parentDirectory);
      } catch {
        throw transportError("maintenance-required");
      }
      if (state.reason !== null) throwAbort(state);
      return { size: receivedSize, sha256 };
    } catch (error) {
      await (response === undefined
        ? Promise.resolve()
        : cancelResponse(response));

      if (!published && stagingCreated) {
        if (!(await confirmWriterClosed())) {
          this.artifactWriterPoisoned = true;
        }
        const stagingRemoved = await unlinkOwnedStaging(
          fileSystem,
          stagingPath,
        );
        stagingCreated = !stagingRemoved;
        if (this.artifactWriterPoisoned || !stagingRemoved)
          throw transportError("maintenance-required");
      }
      if (
        published &&
        error instanceof ReleaseFeedTransportError &&
        error.code === "maintenance-required"
      ) {
        throw error;
      }
      if (state.reason !== null) throwAbort(state);
      if (error instanceof LocalResourceError)
        throw transportError("disk-resource");
      throw error;
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
