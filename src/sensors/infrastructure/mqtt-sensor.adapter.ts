import { Injectable, Logger } from '@nestjs/common';
import { MqttClient } from 'mqtt';
import {
  SensorDriverPort,
  SensorDriverShutdownContext,
} from '../domain/ports/sensor-driver.port';
import { SensorConfig } from '../domain/sensor';
import { SensorEvent } from '../domain/sensor-event';
import { SensorReading } from '../domain/sensor-reading';
import { en } from '../../locales/en';
import { completeWithinShutdownTimeout } from './shutdown-safety';
import { MqttConnectionPool } from './mqtt-connection.pool';
import { MqttSensorConfig, parseMqttConfig } from './mqtt.config';
import { parseMqttPayload } from './mqtt-payload.parser';
import { completeWithinDriverShutdownContext } from './driver-shutdown';

const DEFAULT_MQTT_OFFLINE_ALERT_MS = 60_000;

function mqttOfflineAlertMs(): number {
  const value = Number(process.env.MQTT_OFFLINE_ALERT_MS);
  return Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MQTT_OFFLINE_ALERT_MS;
}

@Injectable()
export class MqttSensorAdapter implements SensorDriverPort {
  private readonly logger = new Logger(MqttSensorAdapter.name);
  private listener?: (event: SensorEvent) => void;
  private last: SensorReading = { value: 0, timestamp: new Date() };
  private config?: SensorConfig;
  private mqttConfig?: MqttSensorConfig;
  private client?: MqttClient;
  private subscriptionFailed = false;
  private hasReceivedMessage = false;
  private lastEmittedAt = 0;
  private destroyed = false;
  private prolongedOfflineSignaled = false;
  private offlineTimer?: NodeJS.Timeout;

  private messageHandler?: (topic: string, payload: Buffer) => void;
  private connectHandler?: () => void;
  private offlineHandler?: () => void;
  private closeHandler?: () => void;

  constructor(private readonly pool: MqttConnectionPool) {}

  async init(config: SensorConfig): Promise<void> {
    this.destroyed = false;
    this.prolongedOfflineSignaled = false;
    this.clearOfflineTimer();
    this.config = config;
    this.mqttConfig = parseMqttConfig(config.config);

    const brokerUrl = this.mqttConfig.brokerUrl;
    const opts = {
      username: this.mqttConfig.username,
      password: this.mqttConfig.password,
      reconnectPeriod: this.mqttConfig.reconnectMs,
    };

    // Obtain shared client from MqttConnectionPool. Fire-and-forget (EC-2)
    this.client = await this.pool.acquire(brokerUrl, opts);

    const doSubscribe = () => {
      if (!this.client || !this.mqttConfig) return;
      this.client.subscribe(this.mqttConfig.topic, { qos: this.mqttConfig.qos }, (err, granted) => {
        if (err) {
          this.logger.warn(`Failed to subscribe to ${this.mqttConfig!.topic}: ${err.message}`);
          this.subscriptionFailed = true;
        } else if (granted?.some((g) => g.qos === 128)) {
          this.logger.warn(`Broker rejected subscription to ${this.mqttConfig!.topic} (SUBACK 0x80)`);
          this.subscriptionFailed = true;
        } else {
          this.subscriptionFailed = false;
        }
      });
    };

    this.connectHandler = () => {
      if (this.destroyed) return;
      this.clearOfflineTimer();
      const wasProlongedOffline = this.prolongedOfflineSignaled;
      this.prolongedOfflineSignaled = false;
      if (wasProlongedOffline) {
        this.emitAvailabilityEvent('state_change', en.sensors.notifications.mqttRecovered, en.sensors.notifications.mqttOffline);
      }
      this.logger.log(`MQTT connected for sensor "${config.name}", subscribing to ${this.mqttConfig!.topic}`);
      doSubscribe();
    };

    this.offlineHandler = () => this.startOfflineTimer();
    this.closeHandler = () => this.startOfflineTimer();

    this.messageHandler = (topic: string, payload: Buffer) => {
      if (topic !== this.mqttConfig?.topic) return;

      // Enforce 64 KB max payload (EC-6)
      if (payload.length > 65536) {
        this.logger.warn(`Payload exceeding 64KB on topic ${topic} dropped for sensor "${config.name}"`);
        return;
      }

      const parsed = parseMqttPayload(payload, this.mqttConfig.format, this.mqttConfig.valueKey);
      if (!parsed) return;

      const now = Date.now();
      const oldValue = this.last.value;
      const newValue = parsed.value;

      // Update state on every valid message
      this.last = {
        value: newValue,
        timestamp: new Date(now),
        raw: parsed.raw,
      };

      // Only emit state_change when value actually changes (EC-7)
      if (this.hasReceivedMessage && newValue === oldValue) return;

      // Debounce window check (EC-8)
      const debounceMs = this.config?.debounceMs ?? 0;
      if (this.hasReceivedMessage && debounceMs > 0 && now - this.lastEmittedAt < debounceMs) {
        return;
      }

      this.hasReceivedMessage = true;
      this.lastEmittedAt = now;

      this.listener?.({
        sensorId: this.config!.id,
        type: 'state_change',
        oldValue,
        newValue,
        timestamp: this.last.timestamp,
      });
    };

    this.client.on('connect', this.connectHandler);
    this.client.on('message', this.messageHandler);
    this.client.on('offline', this.offlineHandler);
    this.client.on('close', this.closeHandler);

    if (this.client.connected) {
      doSubscribe();
    }

    this.logger.log(`MQTT sensor "${config.name}" initialized on topic "${this.mqttConfig.topic}"`);
  }

  async destroy(context?: SensorDriverShutdownContext): Promise<void> {
    this.destroyed = true;
    this.clearOfflineTimer();
    if (!this.client || !this.mqttConfig) return;

    const client = this.client;
    const brokerUrl = this.mqttConfig.brokerUrl;
    const topic = this.mqttConfig.topic;

    if (this.messageHandler) client.off('message', this.messageHandler);
    if (this.connectHandler) client.off('connect', this.connectHandler);
    if (this.offlineHandler) client.off('offline', this.offlineHandler);
    if (this.closeHandler) client.off('close', this.closeHandler);
    this.client = undefined;
    this.listener = undefined;
    this.messageHandler = undefined;
    this.connectHandler = undefined;
    this.offlineHandler = undefined;
    this.closeHandler = undefined;

    if (client.connected) {
      try {
        const unsubscribe = new Promise<void>((resolve) => {
          client.unsubscribe(topic, () => resolve());
        });
        const result = context
          ? await completeWithinDriverShutdownContext(unsubscribe, context)
          : (await completeWithinShutdownTimeout(unsubscribe))
            ? 'completed'
            : 'cancelled';
        if (result === 'cancelled') {
          this.logger.warn(`MQTT unsubscribe timed out for sensor "${this.config?.name ?? 'unknown'}"`);
        }
      } catch {
        this.logger.warn('MQTT unsubscribe failed during destroy');
      }
    }

    if (context) {
      await this.pool.release(brokerUrl, context);
    } else {
      await this.pool.release(brokerUrl);
    }
  }

  getState(): SensorReading {
    return this.last;
  }

  onEvent(callback: (event: SensorEvent) => void): void {
    this.listener = callback;
  }

  async healthCheck(): Promise<boolean> {
    return Boolean(this.client?.connected && !this.subscriptionFailed);
  }

  private startOfflineTimer(): void {
    if (this.destroyed || this.offlineTimer || this.prolongedOfflineSignaled) return;

    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = undefined;
      if (this.destroyed || this.prolongedOfflineSignaled) return;
      this.prolongedOfflineSignaled = true;
      this.emitAvailabilityEvent('error', en.sensors.notifications.mqttOffline);
    }, mqttOfflineAlertMs());
    this.offlineTimer.unref?.();
  }

  private clearOfflineTimer(): void {
    if (!this.offlineTimer) return;
    clearTimeout(this.offlineTimer);
    this.offlineTimer = undefined;
  }

  private emitAvailabilityEvent(
    type: 'error' | 'state_change',
    newValue: string,
    oldValue?: string,
  ): void {
    if (!this.config) return;
    this.listener?.({
      sensorId: this.config.id,
      type,
      oldValue,
      newValue,
      timestamp: new Date(),
    });
  }
}
