import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const defaultPigpioClientLib = require('pigpio-client') as PigpioClientLib;

export const PIGPIO_CLIENT = Symbol('PIGPIO_CLIENT');
const PIGPIO_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export type PudMode = 'up' | 'down' | 'none';

/** Subset of the pigpio-client gpio object we use. */
export interface PigpioGpio {
  modeSet(mode: 'input' | 'output'): Promise<void>;
  pullUpDown(pud: 0 | 1 | 2): Promise<void>;
  read(): Promise<0 | 1>;
  glitchSet(steadyUs: number): Promise<void>;
  notify(cb: (level: 0 | 1, tick: number) => void): void;
  endNotify(): Promise<void>;
}

interface PigpioRoot {
  gpio(pin: number): PigpioGpio;
  connect(): void;
  end(): void;
  getInfo(): { commandSocket?: boolean; notificationSocket?: boolean };
  on(event: 'connected' | 'disconnected' | 'error', cb: (info?: unknown) => void): void;
  once(event: 'connected' | 'disconnected' | 'error', cb: (info?: unknown) => void): void;
}

interface PigpioClientLib {
  pigpio(options: { host: string; port: number }): PigpioRoot;
}

export interface PigpioConnectionState {
  connected: boolean;
  generation: number;
}

/**
 * Singleton wrapper around a pigpio-client connection. All GPIO drivers share
 * one socket to pigpiod. Connection is established lazily and re-used.
 */
@Injectable()
export class PigpioGateway implements OnModuleInit {
  private readonly logger = new Logger(PigpioGateway.name);
  private client: PigpioRoot | null = null;
  private connected = false;
  private generation = 0;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;
  private closePromise: Promise<void> | null = null;
  private readonly connectionStateListeners = new Set<
    (state: PigpioConnectionState) => void
  >();

  constructor(
    @Optional()
    @Inject(PIGPIO_CLIENT)
    private readonly pigpioClient: PigpioClientLib = defaultPigpioClientLib,
  ) {}

  async onModuleInit(): Promise<void> {
    if (
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test' ||
      process.env.PIGPIOD_ENABLED === 'false'
    ) {
      return;
    }
    // Best-effort: don't crash app if pigpiod is down on Pi-less dev hosts.
    try {
      await this.connect();
    } catch (err) {
      this.logger.warn(`pigpiod connect failed: ${(err as Error).message}`);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeClient();
    return this.closePromise;
  }

  private async closeClient(): Promise<void> {
    this.destroyed = true;
    this.clearReconnectTimer();
    this.rejectPendingConnection(new Error('pigpio gateway destroyed'));

    const client = this.client;
    this.client = null;
    this.connected = false;
    this.connectionStateListeners.clear();

    if (client) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  connectionState(): PigpioConnectionState {
    return { connected: this.connected, generation: this.generation };
  }

  onConnectionState(listener: (state: PigpioConnectionState) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.connectionStateListeners.add(listener);
    return () => this.connectionStateListeners.delete(listener);
  }

  /** Connect (idempotent). Resolves when the 'connected' event fires. */
  connect(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('pigpio gateway destroyed'));
    }
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const host = process.env.PIGPIOD_HOST || 'localhost';
    const port = Number.parseInt(process.env.PIGPIOD_PORT || '8888', 10);

    const promise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    this.connectPromise = promise;

    try {
      if (this.client) {
        this.client.connect();
      } else {
        const c = this.pigpioClient.pigpio({ host, port });
        this.client = c;
        this.subscribeToRoot(c, host, port);
      }
    } catch (err) {
      this.handleConnectionFailure(err);
    }

    return promise;
  }

  /** Returns a gpio handle. Caller must `await connect()` first. */
  gpio(pin: number): PigpioGpio {
    if (!this.client || !this.connected) {
      throw new Error('pigpiod not connected');
    }
    return this.client.gpio(pin);
  }

  private subscribeToRoot(client: PigpioRoot, host: string, port: number): void {
    client.on('connected', () => {
      if (this.destroyed || this.client !== client || this.connected) return;

      this.connected = true;
      this.generation += 1;
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();
      this.resolvePendingConnection();
      this.publishConnectionState();
      this.logger.log(`Connected to pigpiod at ${host}:${port}`);
    });
    client.on('disconnected', () => {
      if (this.destroyed || this.client !== client) return;
      if (this.rootIsConnected(client)) return;
      this.logger.warn('Disconnected from pigpiod');
      this.handleConnectionFailure();
    });
    client.on('error', (err) => {
      if (this.destroyed || this.client !== client) return;
      if (this.rootIsConnected(client)) return;
      this.logger.warn(`pigpiod error: ${(err as Error)?.message ?? String(err)}`);
      this.handleConnectionFailure(err);
    });
  }

  private rootIsConnected(client: PigpioRoot): boolean {
    const { commandSocket, notificationSocket } = client.getInfo();
    return commandSocket === true && notificationSocket === true;
  }

  private handleConnectionFailure(error?: unknown): void {
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.publishConnectionState();

    this.rejectPendingConnection(
      error === undefined ? new Error('pigpiod disconnected') : this.asError(error),
    );
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.connected || this.reconnectTimer) return;

    const delay =
      PIGPIO_RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, PIGPIO_RECONNECT_DELAYS_MS.length - 1)
      ];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed || this.connected) return;
      void this.connect().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private resolvePendingConnection(): void {
    const resolve = this.connectResolve;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    resolve?.();
  }

  private rejectPendingConnection(error: Error): void {
    const reject = this.connectReject;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    reject?.(error);
  }

  private publishConnectionState(): void {
    const state = this.connectionState();
    for (const listener of this.connectionStateListeners) listener(state);
  }

  private asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
