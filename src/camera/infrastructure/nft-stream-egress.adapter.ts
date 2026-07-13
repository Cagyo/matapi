import { createConnection } from 'node:net';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StreamEgressUnavailableError } from '../domain/errors/stream-egress-unavailable.error';
import type {
  StreamEgressLease,
  StreamEgressPort,
} from '../domain/ports/stream-egress.port';
import type { StreamEgressGrant } from '../domain/stream-egress-grant.value-object';

const MAX_MESSAGE_BYTES = 16_384;
const DEFAULT_TIMEOUT_MS = 5_000;
const LEASE_ID = /^[0-9a-f]{32}$/u;

export interface LocalStreamHelperClient {
  request(request: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export class UnixLocalStreamHelperClient implements LocalStreamHelperClient {
  constructor(
    private readonly socketPath = '/run/home-worker-stream-net/helper.sock',
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async request(request: Readonly<Record<string, unknown>>): Promise<unknown> {
    const payload = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(payload) > MAX_MESSAGE_BYTES) {
      throw new StreamEgressUnavailableError();
    }
    await inspectHelperSocket(this.socketPath).catch(() => {
      throw new StreamEgressUnavailableError();
    });
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        socket.destroy();
        reject(new StreamEgressUnavailableError());
      };
      const deadline = setTimeout(fail, this.timeoutMs);
      socket.once('error', fail);
      socket.on('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > MAX_MESSAGE_BYTES) return fail();
        chunks.push(chunk);
      });
      socket.once('end', () => {
        if (settled) return;
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!isSuccess(parsed)) return fail();
          settled = true;
          clearTimeout(deadline);
          resolve(parsed);
        } catch {
          fail();
        }
      });
      socket.once('connect', () => socket.end(payload));
    });
  }
}

export class NftStreamEgressAdapter implements StreamEgressPort {
  constructor(private readonly helper: LocalStreamHelperClient) {}

  async grant(request: StreamEgressGrant): Promise<StreamEgressLease> {
    try {
      if (request.isValidated() !== true) throw new Error('invalid');
      const response = await this.helper.request({
        op: 'grant',
        sessionId: request.sessionId,
        nonceHash: request.nonceHash,
        addresses: request.addresses.map(({ address }) => address),
        rtspControlPorts: [...request.rtspControlPorts],
        transport: request.transport.kind,
        ...(request.transport.kind === 'tcp'
          ? {}
          : { udpMediaPorts: { ...request.transport.udpMediaPorts } }),
        expiresAtUnixMs: request.expiresAtUnixMs,
      });
      if (!isLeaseResponse(response)) throw new Error('invalid');
      return { sessionId: request.sessionId, leaseId: response.leaseId };
    } catch {
      throw new StreamEgressUnavailableError();
    }
  }

  async revoke(lease: StreamEgressLease): Promise<void> {
    try {
      if (!UUID.test(lease.sessionId) || !LEASE_ID.test(lease.leaseId)) throw new Error('invalid');
      await this.helper.request({
        op: 'revoke',
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
      });
    } catch {
      throw new StreamEgressUnavailableError();
    }
  }
}

function isSuccess(value: unknown): value is { ok: true } {
  return typeof value === 'object' && value !== null &&
    Object.keys(value).length === 1 && (value as Record<string, unknown>).ok === true;
}

function isLeaseResponse(value: unknown): value is { ok: true; leaseId: string } {
  return typeof value === 'object' && value !== null &&
    Object.keys(value).length === 2 && (value as Record<string, unknown>).ok === true &&
    typeof (value as Record<string, unknown>).leaseId === 'string' &&
    LEASE_ID.test((value as Record<string, unknown>).leaseId as string);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function inspectHelperSocket(path: string): Promise<void> {
  const [parent, endpoint] = await Promise.all([lstat(dirname(path)), lstat(path)]);
  const groups = typeof process.getgroups === 'function' ? process.getgroups() : [];
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 ||
      (parent.mode & 0o007) !== 0 || !endpoint.isSocket() || endpoint.isSymbolicLink() ||
      endpoint.uid !== 0 || (endpoint.mode & 0o777) !== 0o660 || !groups.includes(endpoint.gid)) {
    throw new Error('unsafe helper endpoint');
  }
}
