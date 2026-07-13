import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveStreamSession, type LiveStreamSource } from '../../../src/camera/domain/live-stream.entity';
import {
  QuickTunnelLiveStreamAdapter,
  type CloudflaredChild,
} from '../../../src/camera/infrastructure/quick-tunnel-live-stream.adapter';

const cleanup: Array<() => Promise<void>> = [];

describe('QuickTunnelLiveStreamAdapter', () => {
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  });

  it('rejects a missing viewer token before opening the Motion upstream', async () => {
    const fixture = await createFixture();
    const response = await fetch(`${fixture.localOrigin}/watch/not-valid`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(fixture.motionRequests()).toBe(0);
  });

  it('binds loopback, allows only GET routes, and applies browser hardening headers', async () => {
    const fixture = await createFixture();
    await fixture.adapter.addViewer(viewer('valid'));

    const response = await fetch(`${fixture.localOrigin}/watch/valid`);
    const rejected = await fetch(`${fixture.localOrigin}/watch/valid`, { method: 'POST' });

    expect(new URL(fixture.localOrigin).hostname).toBe('127.0.0.1');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(rejected.status).toBe(404);
    expect(await rejected.text()).toBe('');
    const html = await response.text();
    expect(html).toContain('src="/mjpeg/valid"');
    expect(html).toContain('<title></title>');
    expect(html).toContain('alt=""');
    expect(html).not.toContain('Live camera');
  });

  it('parses one Quick Tunnel hostname and terminates its owned process group', async () => {
    const fixture = await createFixture();

    expect(fixture.started.publicHostname).toBe('clear-moon.trycloudflare.com');
    expect(fixture.spawnArgs).toEqual([
      'tunnel',
      '--url',
      fixture.localOrigin,
      '--no-autoupdate',
    ]);
    expect(fixture.spawnOptions).toMatchObject({ detached: true, shell: false });

    await fixture.adapter.stop();
    expect(fixture.groupSignals).toEqual([{ pid: 41001, signal: 'SIGTERM' }]);
  });

  it('fans one Motion upstream into two authorized viewers', async () => {
    const fixture = await createFixture();
    await fixture.adapter.addViewer(viewer('first'));
    await fixture.adapter.addViewer(viewer('second'));

    const first = fetch(`${fixture.localOrigin}/mjpeg/first`);
    const second = fetch(`${fixture.localOrigin}/mjpeg/second`);
    await vi.waitFor(() => expect(fixture.motionRequests()).toBe(1));

    expect(fixture.adapter.activeViewerCount).toBe(2);
    await fixture.adapter.stop();
    await Promise.all([first, second]);
  });

  it('fans identical complete multipart frames to two viewers across fragmented boundaries', async () => {
    let upstream!: ServerResponse;
    const fixture = await createFixture((response) => {
      upstream = response;
    }, 'multipart/x-mixed-replace; boundary=motion');
    await fixture.adapter.addViewer(viewer('first'));
    await fixture.adapter.addViewer(viewer('second'));
    const firstPromise = fetch(`${fixture.localOrigin}/mjpeg/first`);
    const secondPromise = fetch(`${fixture.localOrigin}/mjpeg/second`);
    await vi.waitFor(() => expect(upstream).toBeDefined());
    const first = await firstPromise;
    const second = await secondPromise;
    const upstreamPartOne = Buffer.from('--motion\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nabc\r\n');
    const upstreamPartTwo = Buffer.from('--motion\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\ndefg\r\n');
    const payload = Buffer.concat([upstreamPartOne, upstreamPartTwo, Buffer.from('--motion')]);
    const expectedPartOne = Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nabc\r\n');
    const expectedPartTwo = Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\ndefg\r\n');
    const firstBytes = readBytes(first, expectedPartOne.length + expectedPartTwo.length);
    const secondBytes = readBytes(second, expectedPartOne.length + expectedPartTwo.length);

    for (const [start, end] of [[0, 3], [3, 11], [11, 67], [67, 73], [73, payload.length]] as const) {
      upstream.write(payload.subarray(start, end));
    }

    const expected = Buffer.concat([expectedPartOne, expectedPartTwo]);
    expect(await firstBytes).toEqual(expected);
    expect(await secondBytes).toEqual(expected);
  });

  it('marks the gateway unavailable after malformed Motion multipart metadata', async () => {
    const fixture = await createFixture(undefined, 'text/plain');
    await fixture.adapter.addViewer(viewer('first'));
    await fixture.adapter.addViewer(viewer('later'));
    const first = await fetch(`${fixture.localOrigin}/mjpeg/first`);
    await vi.waitFor(() => expect(fixture.adapter.activeViewerCount).toBe(0));

    expect((await fetch(`${fixture.localOrigin}/mjpeg/later`)).status).toBe(404);
    expect((await first.arrayBuffer()).byteLength).toBe(0);
  });

  it('closes viewers and rejects later requests after oversized multipart input', async () => {
    let upstream!: ServerResponse;
    const fixture = await createFixture((response) => {
      upstream = response;
    });
    await fixture.adapter.addViewer(viewer('first'));
    await fixture.adapter.addViewer(viewer('later'));
    const first = await fetch(`${fixture.localOrigin}/mjpeg/first`);
    await vi.waitFor(() => expect(upstream).toBeDefined());

    upstream.write(Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    await vi.waitFor(() => expect(fixture.adapter.activeViewerCount).toBe(0));

    expect((await fetch(`${fixture.localOrigin}/mjpeg/later`)).status).toBe(404);
    expect((await first.arrayBuffer()).byteLength).toBe(0);
  });

  it('limits streams to two total and one per token', async () => {
    const fixture = await createFixture();
    await fixture.adapter.addViewer(viewer('first'));
    await fixture.adapter.addViewer(viewer('second'));
    await fixture.adapter.addViewer(viewer('third'));
    const first = fetch(`${fixture.localOrigin}/mjpeg/first`);
    await vi.waitFor(() => expect(fixture.adapter.activeViewerCount).toBe(1));

    expect((await fetch(`${fixture.localOrigin}/mjpeg/first`)).status).toBe(404);
    const second = fetch(`${fixture.localOrigin}/mjpeg/second`);
    await vi.waitFor(() => expect(fixture.adapter.activeViewerCount).toBe(2));
    expect((await fetch(`${fixture.localOrigin}/mjpeg/third`)).status).toBe(404);

    await fixture.adapter.stop();
    await Promise.all([first, second]);
  });

  it('cleans up the child and listener when the external readiness probe fails', async () => {
    const child = fakeChild();
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const adapter = new QuickTunnelLiveStreamAdapter({
      spawnCloudflared: () => child,
      publicProbe: async () => { throw new Error('not externally ready'); },
      identifyProcess: async () => 'start:1',
      processGroupId: async (pid) => pid,
      workerProcessGroupId: 99,
      signalProcessGroup: (pid, signal) => groupSignals.push({ pid, signal }),
      startupTimeoutMs: 500,
      stopGraceMs: 0,
    });
    child.stdout.write('https://clear-moon.trycloudflare.com\n');

    await expect(adapter.start(startInput('http://127.0.0.1:9'))).rejects.toThrow(/ready/i);
    expect(groupSignals).toContainEqual({ pid: 41001, signal: 'SIGTERM' });
    expect(adapter.localOrigin).toBeNull();
  });

  it('rejects duplicate Quick Tunnel hostnames and cleans up', async () => {
    const child = fakeChild();
    const adapter = new QuickTunnelLiveStreamAdapter({
      spawnCloudflared: () => child,
      publicProbe: async () => undefined,
      identifyProcess: async () => 'start:1',
      processGroupId: async (pid) => pid,
      workerProcessGroupId: 99,
      signalProcessGroup: () => undefined,
      startupTimeoutMs: 500,
      stopGraceMs: 0,
    });
    child.stdout.write('https://one.trycloudflare.com https://two.trycloudflare.com\n');

    await expect(adapter.start(startInput('http://127.0.0.1:9'))).rejects.toThrow(/hostname/i);
  });

  it('turns a cloudflared spawn error into bounded start failure cleanup', async () => {
    const child = fakeChild();
    const adapter = new QuickTunnelLiveStreamAdapter({
      spawnCloudflared: () => {
        queueMicrotask(() => child.emit('error', new Error('binary unavailable')));
        return child;
      },
      publicProbe: async () => undefined,
      identifyProcess: async () => 'start:1',
      processGroupId: async (pid) => pid,
      workerProcessGroupId: 99,
      signalProcessGroup: () => undefined,
      startupTimeoutMs: 500,
      stopGraceMs: 0,
    });

    await expect(adapter.start(startInput('http://127.0.0.1:9'))).rejects.toThrow(/binary unavailable/);
    expect(adapter.localOrigin).toBeNull();
  });

  it('positively terminates the spawned child when ownership validation fails', async () => {
    const child = fakeChild();
    const adapter = new QuickTunnelLiveStreamAdapter({
      spawnCloudflared: () => child,
      identifyProcess: async () => null,
      processGroupId: async (pid) => pid,
      workerProcessGroupId: 99,
      startupTimeoutMs: 500,
      stopGraceMs: 0,
    });
    child.stdout.write('https://clear-moon.trycloudflare.com\n');

    await expect(adapter.start(startInput('http://127.0.0.1:9'))).rejects.toThrow(/identity/i);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('retains and terminates an initializing child when stop races startup', async () => {
    const child = fakeChild();
    const identity = deferred<string | null>();
    const identifyProcess = vi.fn(() => identity.promise);
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const adapter = new QuickTunnelLiveStreamAdapter({
      spawnCloudflared: () => child,
      publicProbe: async () => undefined,
      identifyProcess,
      processGroupId: async (pid) => pid,
      workerProcessGroupId: 99,
      signalProcessGroup: (pid, signal) => groupSignals.push({ pid, signal }),
      startupTimeoutMs: 500,
      stopGraceMs: 0,
    });
    child.stdout.write('https://clear-moon.trycloudflare.com\n');

    const starting = adapter.start(startInput('http://127.0.0.1:9'));
    await vi.waitFor(() => expect(identifyProcess).toHaveBeenCalledOnce());
    const stopping = adapter.stop();
    identity.resolve('start:1');
    await Promise.allSettled([starting, stopping]);

    expect(groupSignals).toContainEqual({ pid: 41001, signal: 'SIGTERM' });
    expect(adapter.localOrigin).toBeNull();
  });

  it('rejects a hostname duplicated while external readiness is pending', async () => {
    const child = fakeChild();
    const probe = deferred<void>();
    const publicProbe = vi.fn(() => probe.promise);
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const adapter = new QuickTunnelLiveStreamAdapter({
      spawnCloudflared: () => child,
      publicProbe,
      identifyProcess: async () => 'start:1',
      processGroupId: async (pid) => pid,
      workerProcessGroupId: 99,
      signalProcessGroup: (pid, signal) => groupSignals.push({ pid, signal }),
      startupTimeoutMs: 500,
      stopGraceMs: 0,
    });
    queueMicrotask(() => child.stdout.write('https://clear-moon.trycloudflare.com\n'));
    const starting = adapter.start(startInput('http://127.0.0.1:9'));
    await vi.waitFor(() => expect(publicProbe).toHaveBeenCalledOnce());
    child.stderr.write('https://clear-moon.trycloudflare.com\n');
    probe.resolve();

    await expect(starting).rejects.toThrow(/duplicate hostname/i);
    expect(groupSignals).toContainEqual({ pid: 41001, signal: 'SIGTERM' });
  });

  it('continuously drains cloudflared output after readiness without retaining it', async () => {
    const fixture = await createFixture();
    const noise = Buffer.alloc(256 * 1024, 0x78);

    fixture.child.stdout.write(noise);
    fixture.child.stderr.write(noise);
    await vi.waitFor(() => {
      expect(fixture.child.stdout.readableLength).toBe(0);
      expect(fixture.child.stderr.readableLength).toBe(0);
    });
    expect(fixture.child.stdout.listenerCount('data')).toBeGreaterThan(0);
    expect(fixture.child.stderr.listenerCount('data')).toBeGreaterThan(0);
  });

  it('bounds total retained hostname scan output across stdout and stderr', async () => {
    const child = fakeChild();
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const adapter = new QuickTunnelLiveStreamAdapter({
      spawnCloudflared: () => child,
      identifyProcess: async () => 'start:1',
      processGroupId: async (pid) => pid,
      workerProcessGroupId: 99,
      signalProcessGroup: (pid, signal) => groupSignals.push({ pid, signal }),
      startupTimeoutMs: 500,
      stopGraceMs: 0,
    });
    queueMicrotask(() => {
      child.stdout.write(Buffer.alloc(40 * 1024, 0x78));
      child.stderr.write(Buffer.alloc(30 * 1024, 0x79));
    });

    await expect(adapter.start(startInput('http://127.0.0.1:9'))).rejects.toThrow(/bounded limit/i);
    expect(groupSignals).toContainEqual({ pid: 41001, signal: 'SIGTERM' });
  });

  it('recovers only a process whose current identity matches the lease', async () => {
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const adapter = new QuickTunnelLiveStreamAdapter({
      identifyProcess: async (pid) => pid === 41001 ? 'start:1' : null,
      processGroupId: async (pid) => pid,
      workerProcessGroupId: 99,
      signalProcessGroup: (pid, signal) => groupSignals.push({ pid, signal }),
      stopGraceMs: 0,
    });

    await expect(adapter.recoverOwnedProcess({ pid: 41001 as never, processIdentity: 'other' })).resolves.toBe('not-owned');
    await expect(adapter.recoverOwnedProcess({ pid: 41001 as never, processIdentity: 'start:1' })).resolves.toBe('stopped');
    expect(groupSignals).toEqual([{ pid: 41001, signal: 'SIGTERM' }]);
  });

  it('never signals a PID whose process group is not detached from the worker', async () => {
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const adapter = new QuickTunnelLiveStreamAdapter({
      identifyProcess: async () => 'start:1',
      processGroupId: async () => 99,
      workerProcessGroupId: 99,
      signalProcessGroup: (pid, signal) => groupSignals.push({ pid, signal }),
      stopGraceMs: 0,
    });

    await expect(adapter.recoverOwnedProcess({ pid: 41001 as never, processIdentity: 'start:1' })).resolves.toBe('not-owned');
    expect(groupSignals).toEqual([]);
  });

  it('reports not-owned when final group verification changes before signaling', async () => {
    let groupChecks = 0;
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const adapter = new QuickTunnelLiveStreamAdapter({
      identifyProcess: async () => 'start:1',
      processGroupId: async (pid) => ++groupChecks === 1 ? pid : 99,
      workerProcessGroupId: 99,
      signalProcessGroup: (pid, signal) => groupSignals.push({ pid, signal }),
      stopGraceMs: 0,
    });

    await expect(adapter.recoverOwnedProcess({ pid: 41001 as never, processIdentity: 'start:1' })).resolves.toBe('not-owned');
    expect(groupSignals).toEqual([]);
  });
});

async function createFixture(
  onMotion?: (response: ServerResponse) => void,
  contentType = 'multipart/x-mixed-replace; boundary=frame',
) {
  let motionRequests = 0;
  const motion = createServer((_request, response) => {
    motionRequests += 1;
    response.writeHead(200, { 'content-type': contentType });
    response.flushHeaders();
    if (onMotion) onMotion(response);
    else response.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nabc\r\n');
  });
  const motionOrigin = await listen(motion);
  const child = fakeChild();
  const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let spawnArgs: string[] = [];
  let spawnOptions: Record<string, unknown> = {};
  const adapter = new QuickTunnelLiveStreamAdapter({
    spawnCloudflared: (args, options) => {
      spawnArgs = args;
      spawnOptions = options;
      queueMicrotask(() => child.stderr.write('https://clear-moon.trycloudflare.com\n'));
      return child;
    },
    publicProbe: async () => undefined,
    identifyProcess: async () => 'start:1',
    processGroupId: async (pid) => pid,
    workerProcessGroupId: 99,
    signalProcessGroup: (pid, signal) => groupSignals.push({ pid, signal }),
    startupTimeoutMs: 500,
    stopGraceMs: 0,
  });
  const started = await adapter.start(startInput(`${motionOrigin}/stream`));
  const localOrigin = adapter.localOrigin!;
  cleanup.push(async () => {
    await adapter.stop();
    await close(motion);
  });
  return { adapter, child, started, localOrigin, motionRequests: () => motionRequests, groupSignals, spawnArgs, spawnOptions };
}

function startInput(upstreamUrl: string) {
  return {
    session: createLiveStreamSession({ id: 'session', cameraId: 'front', cameraName: 'Front', startedMonotonicMs: 1, durationMs: 300_000 }),
    source: { kind: 'motion-mjpeg', cameraId: 'front', cameraName: 'Front', upstreamUrl } satisfies LiveStreamSource,
  };
}

function viewer(token: string) {
  return { tokenHash: createHash('sha256').update(token).digest('hex'), telegramId: 1, expiresMonotonicMs: Number.MAX_SAFE_INTEGER };
}

function fakeChild(): CloudflaredChild {
  const child = new EventEmitter() as CloudflaredChild;
  child.pid = 41001;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readBytes(response: Response, length: number): Promise<Buffer> {
  const reader = response.body!.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < length) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed before expected multipart bytes');
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      total += chunk.length;
    }
    return Buffer.concat(chunks).subarray(0, length);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
