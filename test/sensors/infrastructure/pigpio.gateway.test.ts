import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PigpioConnectionState,
  PigpioGateway,
  PigpioGpio,
} from '../../../src/sensors/infrastructure/pigpio.gateway';

type PigpioEvent = 'connected' | 'disconnected' | 'error';
type Handler = (info?: unknown) => void;

function makeClient(gpio: PigpioGpio) {
  const onceHandlers = new Map<PigpioEvent, Handler[]>();
  const onHandlers = new Map<PigpioEvent, Handler[]>();
  const connectionInfo = { commandSocket: false, notificationSocket: false };
  const emitHandlers = (event: PigpioEvent, info?: unknown) => {
    const once = onceHandlers.get(event) ?? [];
    onceHandlers.set(event, []);
    for (const handler of [...(onHandlers.get(event) ?? []), ...once]) handler(info);
  };

  return {
    gpio: vi.fn(() => gpio),
    connect: vi.fn(),
    end: vi.fn(),
    getInfo: vi.fn(() => connectionInfo),
    once: vi.fn((event: PigpioEvent, handler: Handler) => {
      onceHandlers.set(event, [...(onceHandlers.get(event) ?? []), handler]);
    }),
    on: vi.fn((event: PigpioEvent, handler: Handler) => {
      onHandlers.set(event, [...(onHandlers.get(event) ?? []), handler]);
    }),
    emit(event: PigpioEvent, info?: unknown) {
      if (event === 'connected') {
        connectionInfo.commandSocket = true;
        connectionInfo.notificationSocket = true;
      }
      if (event === 'disconnected') {
        connectionInfo.commandSocket = false;
        connectionInfo.notificationSocket = false;
      }
      emitHandlers(event, info);
    },
    emitStale(event: PigpioEvent, info?: unknown) {
      emitHandlers(event, info);
    },
  };
}

const originalPigpiodHost = process.env.PIGPIOD_HOST;
const originalPigpiodPort = process.env.PIGPIOD_PORT;

function restoreEnv(): void {
  if (originalPigpiodHost === undefined) delete process.env.PIGPIOD_HOST;
  else process.env.PIGPIOD_HOST = originalPigpiodHost;

  if (originalPigpiodPort === undefined) delete process.env.PIGPIOD_PORT;
  else process.env.PIGPIOD_PORT = originalPigpiodPort;
}

describe('PigpioGateway', () => {
  let pigpioClient: { pigpio: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    pigpioClient = { pigpio: vi.fn() };
  });

  afterEach(() => {
    restoreEnv();
    vi.useRealTimers();
  });

  it('throws when requesting gpio before a connection is ready', () => {
    expect(() => new PigpioGateway().gpio(17)).toThrow('pigpiod not connected');
  });

  it('connects through pigpio-client and returns gpio handles after connection', async () => {
    process.env.PIGPIOD_HOST = 'pi.local';
    process.env.PIGPIOD_PORT = '9999';
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    const promise = gateway.connect();
    expect(pigpioClient.pigpio).toHaveBeenCalledWith({ host: 'pi.local', port: 9999 });
    client.emit('connected');
    await promise;

    expect(gateway.isConnected()).toBe(true);
    expect(gateway.gpio(17)).toBe(gpio);

    client.emit('disconnected');
    expect(gateway.isConnected()).toBe(false);
  });

  it('reuses the in-flight connection promise', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    const first = gateway.connect();
    const second = gateway.connect();
    client.emit('connected');

    expect(second).toBe(first);
    await first;
    expect(pigpioClient.pigpio).toHaveBeenCalledTimes(1);
  });

  it('resets state when connect emits an error', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    const promise = gateway.connect();
    client.emit('error', new Error('refused'));

    await expect(promise).rejects.toThrow('refused');
    expect(gateway.isConnected()).toBe(false);
  });

  it('clears a rejected connection promise so an immediate fresh connect can proceed', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    const failed = gateway.connect();
    client.emit('error', new Error('refused'));
    await expect(failed).rejects.toThrow('refused');

    const retry = gateway.connect();
    expect(retry).not.toBe(failed);
    expect(client.connect).toHaveBeenCalledTimes(1);
    client.emit('connected');
    await retry;

    expect((gateway as unknown as { connectPromise: Promise<void> | null }).connectPromise).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('creates a fresh root after synchronous initial root creation failure', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio
      .mockImplementationOnce(() => {
        throw new Error('pigpiod unavailable');
      })
      .mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    await expect(gateway.connect()).rejects.toThrow('pigpiod unavailable');
    expect((gateway as unknown as { client: unknown }).client).toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pigpioClient.pigpio).toHaveBeenCalledTimes(2);
    client.emit('connected');
    expect(gateway.connectionState()).toEqual({ connected: true, generation: 1 });
  });

  it('ends an active client through its public close operation', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    const promise = gateway.connect();
    client.emit('connected');
    await promise;
    await gateway.close();

    expect(client.end).toHaveBeenCalledTimes(1);
    expect(gateway.isConnected()).toBe(false);
  });

  it('shares one close operation across concurrent callers', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    const connected = gateway.connect();
    client.emit('connected');
    await connected;
    const first = gateway.close();
    const second = gateway.close();

    expect(second).toBe(first);
    await first;
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('publishes the initial connected state with generation one', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);
    const states: PigpioConnectionState[] = [];
    gateway.onConnectionState((state) => states.push(state));

    const promise = gateway.connect();
    client.emit('connected');
    await promise;

    expect(gateway.connectionState()).toEqual({ connected: true, generation: 1 });
    expect(states).toEqual([{ connected: true, generation: 1 }]);
  });

  it('reconnects the shared root once after a disconnect and advances generation', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);
    const states: PigpioConnectionState[] = [];
    gateway.onConnectionState((state) => states.push(state));

    const initial = gateway.connect();
    client.emit('connected');
    await initial;
    client.emit('disconnected');

    expect(gateway.connectionState()).toEqual({ connected: false, generation: 1 });
    await vi.advanceTimersByTimeAsync(999);
    expect(client.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.connect).toHaveBeenCalledTimes(1);

    client.emit('connected');

    expect(gateway.connectionState()).toEqual({ connected: true, generation: 2 });
    expect(states).toEqual([
      { connected: true, generation: 1 },
      { connected: false, generation: 1 },
      { connected: true, generation: 2 },
    ]);
    expect((gateway as unknown as { connectPromise: Promise<void> | null }).connectPromise).toBeNull();
    expect(pigpioClient.pigpio).toHaveBeenCalledTimes(1);
  });

  it('ignores a delayed disconnected event after the shared root reconnects', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    const initial = gateway.connect();
    client.emit('connected');
    await initial;
    client.emit('disconnected');
    await vi.advanceTimersByTimeAsync(1_000);
    client.emit('connected');

    client.emitStale('disconnected');

    expect(gateway.connectionState()).toEqual({ connected: true, generation: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces error and disconnected signals for one outage into one retry timer', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    const initial = gateway.connect();
    client.emit('connected');
    await initial;
    client.emit('error', new Error('socket failure'));
    client.emit('disconnected');

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it('uses bounded reconnect delays after repeated connection failures', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    const initial = gateway.connect();
    client.emit('connected');
    await initial;
    client.emit('disconnected');

    const delays = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
    for (const [attempt, delay] of delays.entries()) {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(client.connect).toHaveBeenCalledTimes(attempt);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.connect).toHaveBeenCalledTimes(attempt + 1);
      client.emit('error', new Error('refused'));
    }

    await gateway.close();
  });

  it('resets the reconnect delay to one second after a successful connection', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);

    const initial = gateway.connect();
    client.emit('connected');
    await initial;
    client.emit('disconnected');
    await vi.advanceTimersByTimeAsync(1_000);
    client.emit('error', new Error('refused'));
    expect(vi.getTimerCount()).toBe(1);

    client.emit('connected');
    expect(vi.getTimerCount()).toBe(0);
    client.emit('disconnected');
    await vi.advanceTimersByTimeAsync(999);
    expect(client.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it('cleans up a disconnected root and suppresses callbacks after destruction', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient);
    const states: PigpioConnectionState[] = [];
    gateway.onConnectionState((state) => states.push(state));

    const initial = gateway.connect();
    client.emit('connected');
    await initial;
    client.emit('disconnected');
    await gateway.close();
    const stateCountAtDestroy = states.length;

    expect(client.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    client.emit('connected');
    client.emit('error', new Error('late error'));
    client.emit('disconnected');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(client.connect).not.toHaveBeenCalled();
    expect(states).toHaveLength(stateCountAtDestroy);
    expect(vi.getTimerCount()).toBe(0);
  });
});
