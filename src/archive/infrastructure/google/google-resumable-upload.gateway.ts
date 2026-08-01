import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { DriveConfigurationError } from '../../domain/errors/drive-configuration.error';
import { DriveTemporaryUnavailableError } from '../../domain/errors/drive-temporary-unavailable.error';

const INITIATION_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&ignoreDefaultVisibility=true';
const SESSION_PATH = '/upload/drive/v3/files';
const CHUNK_ALIGNMENT = 256 * 1024;
const LOCAL_SESSION_LIFETIME_MS = 6 * 24 * 60 * 60 * 1_000;

export interface GoogleResumableDeadlines {
  connectMs: number;
  responseMs: number;
  idleMs: number;
  totalMs: number;
}

export interface GoogleResumableTransportRequest {
  method: 'POST' | 'PUT';
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string | AsyncIterable<Uint8Array>;
  signal: AbortSignal;
  deadlines: GoogleResumableDeadlines;
}

export interface GoogleResumableTransportResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
}

export interface GoogleResumableTransport {
  request(input: GoogleResumableTransportRequest): Promise<GoogleResumableTransportResponse>;
}

export interface GoogleResumableUploadGatewayOptions {
  now?: () => number;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

interface AuthorizedBegin {
  authorization: string;
  fileId: string;
  parentId: string;
  name: string;
  mimeType: string;
  size: number;
  appProperties: Readonly<Record<string, string>>;
}

interface AuthorizedQuery {
  authorization: string;
  uri: string;
  totalSize: number;
}

interface AuthorizedChunk extends AuthorizedQuery {
  fileId?: string;
  start: number;
  endInclusive: number;
  body: AsyncIterable<Uint8Array>;
}

export class GoogleResumableUploadGateway {
  private readonly now: () => number;
  private readonly deadlines: GoogleResumableDeadlines;

  constructor(
    private readonly transport: GoogleResumableTransport = new NodeHttpsResumableTransport(),
    options: GoogleResumableUploadGatewayOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.deadlines = {
      connectMs: options.connectTimeoutMs ?? 10_000,
      responseMs: options.responseTimeoutMs ?? 30_000,
      idleMs: options.idleTimeoutMs ?? 30_000,
      totalMs: options.totalTimeoutMs ?? 120_000,
    };
  }

  async begin(input: AuthorizedBegin, signal: AbortSignal): Promise<{ uri: string; createdAtMs: number; expiresAtMs: number }> {
    throwIfAborted(signal);
    requireSize(input.size);
    const response = await this.transport.request({
      method: 'POST',
      url: INITIATION_URL,
      headers: {
        authorization: input.authorization,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(input.size),
        'x-upload-content-type': input.mimeType,
      },
      body: JSON.stringify({
        id: input.fileId,
        name: input.name,
        mimeType: input.mimeType,
        parents: [input.parentId],
        appProperties: { ...input.appProperties },
      }),
      signal,
      deadlines: this.deadlines,
    });
    if (response.status !== 200 && response.status !== 201) throw statusError(response.status);
    const uri = validateSessionUri(header(response.headers, 'location'));
    const createdAtMs = this.now();
    return { uri, createdAtMs, expiresAtMs: createdAtMs + LOCAL_SESSION_LIFETIME_MS };
  }

  async querySession(input: AuthorizedQuery, signal: AbortSignal): Promise<
    { kind: 'complete' } | { kind: 'resume'; confirmedOffset: number } | { kind: 'expired' }
  > {
    throwIfAborted(signal);
    requireSize(input.totalSize);
    const uri = validateSessionUri(input.uri);
    const response = await this.transport.request({
      method: 'PUT', url: uri,
      headers: {
        authorization: input.authorization,
        'content-length': '0',
        'content-range': `bytes */${input.totalSize}`,
      },
      signal,
      deadlines: this.deadlines,
    });
    if (response.status === 200 || response.status === 201) return { kind: 'complete' };
    if (response.status === 308) return { kind: 'resume', confirmedOffset: parseConfirmedOffset(response.headers, input.totalSize) };
    if (response.status === 404) return { kind: 'expired' };
    throw statusError(response.status);
  }

  async uploadChunk(input: AuthorizedChunk, signal: AbortSignal): Promise<
    { kind: 'complete' } | { kind: 'resume'; confirmedOffset: number }
  > {
    throwIfAborted(signal);
    const uri = validateSessionUri(input.uri);
    requireChunk(input.start, input.endInclusive, input.totalSize);
    const length = input.endInclusive - input.start + 1;
    const response = await this.transport.request({
      method: 'PUT', url: uri,
      headers: {
        authorization: input.authorization,
        'content-length': String(length),
        'content-range': `bytes ${input.start}-${input.endInclusive}/${input.totalSize}`,
      },
      body: input.body,
      signal,
      deadlines: this.deadlines,
    });
    if (response.status === 200 || response.status === 201) return { kind: 'complete' };
    if (response.status === 308) return { kind: 'resume', confirmedOffset: parseConfirmedOffset(response.headers, input.totalSize) };
    throw statusError(response.status);
  }
}

export class NodeHttpsResumableTransport implements GoogleResumableTransport {
  async request(input: GoogleResumableTransportRequest): Promise<GoogleResumableTransportResponse> {
    throwIfAborted(input.signal);
    const total = AbortSignal.timeout(input.deadlines.totalMs);
    const signal = AbortSignal.any([input.signal, total]);
    return new Promise((resolve, reject) => {
      const url = new URL(input.url);
      const options: RequestOptions = {
        protocol: 'https:', hostname: url.hostname, port: url.port || undefined,
        path: `${url.pathname}${url.search}`, method: input.method,
        headers: input.headers, signal,
      };
      let settled = false;
      const req = httpsRequest(options, (response) => {
        clearTimeout(connectTimer);
        clearTimeout(responseTimer);
        let idleTimer = setTimeout(() => req.destroy(new Error('Google upload idle deadline exceeded')), input.deadlines.idleMs);
        const resetIdle = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => req.destroy(new Error('Google upload idle deadline exceeded')), input.deadlines.idleMs);
        };
        response.on('data', resetIdle);
        response.on('end', () => {
          clearTimeout(idleTimer);
          settled = true;
          resolve({ status: response.statusCode ?? 0, headers: normalizeHeaders(response.headers) });
        });
        response.resume();
      });
      const connectTimer = setTimeout(() => req.destroy(new Error('Google upload connect deadline exceeded')), input.deadlines.connectMs);
      const responseTimer = setTimeout(() => req.destroy(new Error('Google upload response deadline exceeded')), input.deadlines.responseMs);
      req.once('socket', (socket) => {
        if (!socket.connecting) clearTimeout(connectTimer);
        socket.once('secureConnect', () => clearTimeout(connectTimer));
      });
      req.once('error', (error) => {
        clearTimeout(connectTimer);
        clearTimeout(responseTimer);
        if (!settled) reject(mapTransportError(error, input.signal, total));
      });
      void writeBody(req, input.body, signal).catch((error) => req.destroy(error instanceof Error ? error : new Error('Google upload body failed')));
    });
  }
}

async function writeBody(
  request: ReturnType<typeof httpsRequest>,
  body: GoogleResumableTransportRequest['body'],
  signal: AbortSignal,
): Promise<void> {
  if (body === undefined) { request.end(); return; }
  if (typeof body === 'string') { request.end(body); return; }
  for await (const part of body) {
    throwIfAborted(signal);
    if (!request.write(part)) await once(request, 'drain');
  }
  request.end();
}

function validateSessionUri(value: string | undefined): string {
  if (!value) throw new DriveConfigurationError('Google resumable Location is not allowlisted');
  let url: URL;
  try { url = new URL(value); } catch { throw new DriveConfigurationError('Google resumable Location is not allowlisted'); }
  const keys = [...url.searchParams.keys()];
  const uploadTypes = url.searchParams.getAll('uploadType');
  const uploadIds = url.searchParams.getAll('upload_id');
  if (url.protocol !== 'https:' || url.hostname !== 'www.googleapis.com' || url.port !== ''
    || url.username !== '' || url.password !== '' || url.pathname !== SESSION_PATH || url.hash !== ''
    || keys.length !== 2 || new Set(keys).size !== 2
    || uploadTypes.length !== 1 || uploadTypes[0] !== 'resumable'
    || uploadIds.length !== 1 || uploadIds[0].length === 0) {
    throw new DriveConfigurationError('Google resumable Location is not allowlisted');
  }
  return url.toString();
}

function parseConfirmedOffset(headers: Readonly<Record<string, string | undefined>>, totalSize: number): number {
  const value = header(headers, 'range');
  if (value === undefined) return 0;
  const match = /^bytes=0-(\d+)$/u.exec(value);
  if (!match) throw new DriveConfigurationError('Google resumable Range is malformed');
  const end = Number(match[1]);
  const offset = end + 1;
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > totalSize) {
    throw new DriveConfigurationError('Google resumable Range is malformed');
  }
  return offset;
}

function requireChunk(start: number, endInclusive: number, totalSize: number): void {
  requireSize(totalSize);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start || endInclusive >= totalSize) {
    throw new DriveConfigurationError('Google resumable chunk range is malformed');
  }
  const length = endInclusive - start + 1;
  if (endInclusive + 1 < totalSize && length % CHUNK_ALIGNMENT !== 0) {
    throw new DriveConfigurationError('Non-final Google resumable chunks must be 256 KiB multiples');
  }
}

function requireSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new DriveConfigurationError('Google upload size is malformed');
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

function normalizeHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value]));
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

function statusError(status: number): Error {
  return new DriveTemporaryUnavailableError(`Google resumable upload failed (${status})`);
}

function mapTransportError(error: unknown, caller: AbortSignal, total: AbortSignal): Error {
  if (caller.aborted) return caller.reason instanceof Error ? caller.reason : new DOMException('Aborted', 'AbortError');
  if (total.aborted) return new DriveTemporaryUnavailableError('Google resumable upload total deadline exceeded');
  return new DriveTemporaryUnavailableError(error instanceof Error && error.message.includes('deadline')
    ? error.message : 'Google resumable upload transport failed');
}
