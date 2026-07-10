import { Injectable, Logger } from '@nestjs/common';
import * as mqtt from 'mqtt';
import { IClientOptions, MqttClient } from 'mqtt';
import { SensorDriverShutdownContext } from '../domain/ports/sensor-driver.port';
import {
  completeWithinShutdownTimeout,
  safeBrokerUrl,
} from './shutdown-safety';
import { completeWithinDriverShutdownContext } from './driver-shutdown';

@Injectable()
export class MqttConnectionPool {
  private readonly logger = new Logger(MqttConnectionPool.name);
  private pool = new Map<string, { client: MqttClient; refCount: number }>();
  private destroyPromise: Promise<void> | null = null;
  private lifecycleShutdownStarted = false;

  /** Get or create a shared connection. Increments ref count. */
  async acquire(brokerUrl: string, opts?: IClientOptions): Promise<MqttClient> {
    const normalizedUrl = brokerUrl.trim();
    const existing = this.pool.get(normalizedUrl);
    if (existing) {
      existing.refCount += 1;
      this.logger.debug(
        `Reusing MQTT client for ${safeBrokerUrl(normalizedUrl)} (refCount: ${existing.refCount})`,
      );
      return existing.client;
    }

    this.logger.log(`Creating new MQTT client for ${safeBrokerUrl(normalizedUrl)}`);
    // Using connect() ensures non-blocking fire-and-forget connection behavior (EC-2)
    const client = mqtt.connect(normalizedUrl, {
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      ...opts,
    });

    client.on('error', () => {
      this.logger.warn(`MQTT connection error (${safeBrokerUrl(normalizedUrl)})`);
    });

    client.on('offline', () => {
      this.logger.debug(`MQTT client offline (${safeBrokerUrl(normalizedUrl)})`);
    });

    client.on('reconnect', () => {
      this.logger.debug(`MQTT client reconnecting (${safeBrokerUrl(normalizedUrl)})`);
    });

    client.on('connect', () => {
      this.logger.log(`MQTT client connected (${safeBrokerUrl(normalizedUrl)})`);
    });

    this.pool.set(normalizedUrl, { client, refCount: 1 });
    return client;
  }

  /** Decrement ref count. Closes connection when last consumer releases. */
  async release(brokerUrl: string, context?: SensorDriverShutdownContext): Promise<void> {
    const normalizedUrl = brokerUrl.trim();
    const existing = this.pool.get(normalizedUrl);
    if (!existing) return;

    existing.refCount -= 1;
    this.logger.debug(
      `Released MQTT client for ${safeBrokerUrl(normalizedUrl)} (refCount: ${existing.refCount})`,
    );

    if (existing.refCount <= 0) {
      if (this.lifecycleShutdownStarted) {
        this.logger.debug(
          `Deferring MQTT close to lifecycle shutdown (${safeBrokerUrl(normalizedUrl)})`,
        );
        return;
      }
      this.pool.delete(normalizedUrl);
      this.logger.log(`Closing MQTT connection for ${safeBrokerUrl(normalizedUrl)}`);
      try {
        const closed = context
          ? (await completeWithinDriverShutdownContext(existing.client.endAsync(true), context)) ===
            'completed'
          : await completeWithinShutdownTimeout(existing.client.endAsync(true));
        if (!closed) {
          this.logger.warn(`MQTT client close timed out (${safeBrokerUrl(normalizedUrl)})`);
        }
      } catch {
        this.logger.warn(`MQTT client close failed (${safeBrokerUrl(normalizedUrl)})`);
      }
    }
  }

  /** Prevent last-reference release from closing a client before driver teardown finishes. */
  beginLifecycleShutdown(): void {
    this.lifecycleShutdownStarted = true;
  }

  /** Force-close all connections (module shutdown). */
  destroyAll(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.lifecycleShutdownStarted = true;
    this.destroyPromise = this.closeAllConnections();
    return this.destroyPromise;
  }

  private async closeAllConnections(): Promise<void> {
    const entries = Array.from(this.pool.entries());
    this.pool.clear();
    for (const [url, entry] of entries) {
      this.logger.log(`Force closing MQTT client for ${safeBrokerUrl(url)}`);
      try {
        const closed = await completeWithinShutdownTimeout(entry.client.endAsync(true));
        if (!closed) {
          this.logger.warn(`MQTT client force-close timed out (${safeBrokerUrl(url)})`);
        }
      } catch {
        this.logger.warn(`MQTT client force-close failed (${safeBrokerUrl(url)})`);
      }
    }
  }
}
