import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PigpioGateway, PigpioGpio } from '../../../src/sensors/drivers/pigpio.gateway';

type PigpioEvent = 'connected' | 'disconnected' | 'error';
type Handler = (info?: unknown) => void;

function makeClient(gpio: PigpioGpio) {
  const onceHandlers = new Map<PigpioEvent, Handler[]>();
  const onHandlers = new Map<PigpioEvent, Handler[]>();
  return {
    gpio: vi.fn(() => gpio),
    end: vi.fn(),
    once: vi.fn((event: PigpioEvent, handler: Handler) => {
      onceHandlers.set(event, [...(onceHandlers.get(event) ?? []), handler]);
    }),
    on: vi.fn((event: PigpioEvent, handler: Handler) => {
      onHandlers.set(event, [...(onHandlers.get(event) ?? []), handler]);
    }),
    emitOnce(event: PigpioEvent, info?: unknown) {
      const handlers = onceHandlers.get(event) ?? [];
      onceHandlers.set(event, []);
      for (const handler of handlers) handler(info);
    },
    emitOn(event: PigpioEvent, info?: unknown) {
      for (const handler of onHandlers.get(event) ?? []) handler(info);
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
    pigpioClient = { pigpio: vi.fn() };
  });

  afterEach(() => {
    restoreEnv();
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
    const gateway = new PigpioGateway(pigpioClient as never);

    const promise = gateway.connect();
    expect(pigpioClient.pigpio).toHaveBeenCalledWith({ host: 'pi.local', port: 9999 });
    client.emitOnce('connected');
    await promise;

    expect(gateway.isConnected()).toBe(true);
    expect(gateway.gpio(17)).toBe(gpio);
    expect(client.gpio).toHaveBeenCalledWith(17);

    client.emitOn('disconnected');
    expect(gateway.isConnected()).toBe(false);
  });

  it('reuses the in-flight connection promise', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient as never);

    const first = gateway.connect();
    const second = gateway.connect();
    client.emitOnce('connected');

    expect(second).toBe(first);
    await first;
    expect(pigpioClient.pigpio).toHaveBeenCalledTimes(1);
  });

  it('resets connection state when connect emits an error', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient as never);

    const promise = gateway.connect();
    client.emitOnce('error', new Error('refused'));

    await expect(promise).rejects.toThrow('refused');
    expect(gateway.isConnected()).toBe(false);
  });

  it('ends an active client on module destroy', async () => {
    const gpio = { read: vi.fn() } as unknown as PigpioGpio;
    const client = makeClient(gpio);
    pigpioClient.pigpio.mockReturnValue(client);
    const gateway = new PigpioGateway(pigpioClient as never);

    const promise = gateway.connect();
    client.emitOnce('connected');
    await promise;
    await gateway.onModuleDestroy();

    expect(client.end).toHaveBeenCalledTimes(1);
    expect(gateway.isConnected()).toBe(false);
  });
});