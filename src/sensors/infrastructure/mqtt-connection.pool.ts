import { Injectable, Logger } from '@nestjs/common';
import * as mqtt from 'mqtt';
import { IClientOptions, MqttClient } from 'mqtt';

@Injectable()
export class MqttConnectionPool {
  private readonly logger = new Logger(MqttConnectionPool.name);
  private pool = new Map<string, { client: MqttClient; refCount: number }>();
  private destroyPromise: Promise<void> | null = null;

  /** Get or create a shared connection. Increments ref count. */
  async acquire(brokerUrl: string, opts?: IClientOptions): Promise<MqttClient> {
    const normalizedUrl = brokerUrl.trim();
    const existing = this.pool.get(normalizedUrl);
    if (existing) {
      existing.refCount += 1;
      this.logger.debug(`Reusing MQTT client for ${normalizedUrl} (refCount: ${existing.refCount})`);
      return existing.client;
    }

    this.logger.log(`Creating new MQTT client for ${normalizedUrl}`);
    // Using connect() ensures non-blocking fire-and-forget connection behavior (EC-2)
    const client = mqtt.connect(normalizedUrl, {
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      ...opts,
    });

    client.on('error', (err) => {
      this.logger.warn(`MQTT connection error (${normalizedUrl}): ${err.message}`);
    });

    client.on('offline', () => {
      this.logger.debug(`MQTT client offline (${normalizedUrl})`);
    });

    client.on('reconnect', () => {
      this.logger.debug(`MQTT client reconnecting (${normalizedUrl})`);
    });

    client.on('connect', () => {
      this.logger.log(`MQTT client connected (${normalizedUrl})`);
    });

    this.pool.set(normalizedUrl, { client, refCount: 1 });
    return client;
  }

  /** Decrement ref count. Closes connection when last consumer releases. */
  async release(brokerUrl: string): Promise<void> {
    const normalizedUrl = brokerUrl.trim();
    const existing = this.pool.get(normalizedUrl);
    if (!existing) return;

    existing.refCount -= 1;
    this.logger.debug(`Released MQTT client for ${normalizedUrl} (refCount: ${existing.refCount})`);

    if (existing.refCount <= 0) {
      this.pool.delete(normalizedUrl);
      this.logger.log(`Closing MQTT connection for ${normalizedUrl}`);
      try {
        await existing.client.endAsync(true);
      } catch (err) {
        this.logger.warn(`Error closing MQTT client (${normalizedUrl}): ${(err as Error).message}`);
      }
    }
  }

  /** Force-close all connections (module shutdown). */
  destroyAll(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this.closeAllConnections();
    return this.destroyPromise;
  }

  private async closeAllConnections(): Promise<void> {
    const entries = Array.from(this.pool.entries());
    this.pool.clear();
    for (const [url, entry] of entries) {
      this.logger.log(`Force closing MQTT client for ${url}`);
      try {
        await entry.client.endAsync(true);
      } catch (err) {
        this.logger.warn(`Error force closing MQTT client (${url}): ${(err as Error).message}`);
      }
    }
  }
}
