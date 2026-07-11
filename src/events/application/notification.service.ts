import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SENSOR_QUERY,
  SensorQueryPort,
} from '../../sensors/domain/ports/sensor-query.port';
import { en } from '../../locales/en';
import { SensorSeverity } from '../../sensors/domain/sensor';
import { isInQuietHours } from '../domain/quiet-hours';
import { formatMotionCaption } from '../domain/motion-notification';
import { formatSensorNotification } from '../domain/sensor-notification';
import { CLOCK, ClockPort } from '../domain/ports/clock.port';
import {
  EVENT_REPOSITORY,
  EventRepositoryPort,
} from '../domain/ports/event-repository.port';
import { NOTIFIER, NotifierPort } from '../domain/ports/notifier.port';
import {
  NotificationRecipient,
  RECIPIENT_DIRECTORY,
  RecipientDirectoryPort,
} from '../domain/ports/recipient.port';
import { QueuedEvent } from '../domain/queued-event.entity';
import { forEachWithConcurrency } from './concurrency';
import { DebounceService } from './debounce.service';
import {
  NOTIFICATION_OPTIONS,
  NotificationOptions,
} from './ports/notification-options.port';

/** Max simultaneous Telegram sends per event — one slow chat cannot block the rest. */
const SEND_CONCURRENCY = 5;

/**
 * Output side of the event queue (spec 19). For each freshly-queued event it
 * decides who receives it, applies debounce / mute / quiet-hours rules, sends
 * per eligible user, and marks the event sent. Depends only on ports — no
 * Drizzle, no grammY, no `Date.now()`.
 *
 * When the notifier is offline the event is left queued for the drain
 * (spec 05). When there are no per-user recipients (mock/dev, or before the
 * first user registers) it falls back to a broadcast so dev output still
 * surfaces events.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(NOTIFIER) private readonly notifier: NotifierPort,
    @Inject(RECIPIENT_DIRECTORY)
    private readonly recipients: RecipientDirectoryPort,
    @Inject(SENSOR_QUERY) private readonly sensors: SensorQueryPort,
    @Inject(EVENT_REPOSITORY) private readonly events: EventRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(NOTIFICATION_OPTIONS) private readonly options: NotificationOptions,
    @Inject(DebounceService) private readonly debounce: DebounceService,
  ) {}

  async process(event: QueuedEvent): Promise<void> {
    // Notifier offline → leave queued; the drain delivers on reconnect.
    if (!this.notifier.isReady()) return;

    const sensorId = event.sensorId;
    if (!sensorId) {
      // System events without a sensor: broadcast, no per-user filtering.
      await this.broadcast(event);
      return;
    }

    const newValue = (event.payload as { newValue?: unknown } | null)?.newValue;

    // Debounce only applies to repeated identical state changes.
    if (event.type === 'state_change') {
      const allowed = await this.debounce.shouldNotify(sensorId, newValue);
      if (!allowed) {
        await this.markSent(event);
        return;
      }
    }

    const sensor = await this.sensors.findById(sensorId);
    const isFlappingFault =
      event.type === 'system' && newValue === 'flapping_fault';
    const severity: SensorSeverity =
      isFlappingFault ? 'warning' : sensor?.severity ?? readSeverity(event) ?? 'info';
    const name = sensor?.name ?? readName(event) ?? sensorId;
    const stepType =
      typeof sensor?.config?.stepType === 'string' ? sensor.config.stepType : undefined;
    const text = isFlappingFault
      ? en.sensors.notifications.flappingFault(name)
      : formatSensorNotification({
          type: sensor?.type ?? null,
          name,
          value: newValue,
          oldValue: (event.payload as { oldValue?: unknown } | null)?.oldValue,
          severity,
          stepType,
        });
    const requiresLogsAction =
      isFlappingFault ||
      (event.type === 'state_change' &&
        (stepType === 'alarm' || stepType === 'leak_hazard') &&
        isActiveValue(newValue));
    const logsCallbackData = sensor ? `logs:id:${sensor.id}` : null;
    const actions =
      requiresLogsAction &&
      logsCallbackData &&
      Buffer.byteLength(logsCallbackData, 'utf8') <= 64
        ? [[{ text: en.sensors.notifications.viewLogs, callbackData: logsCallbackData }]]
        : undefined;

    const recipients = await this.recipients.listRecipients();
    if (recipients.length === 0) {
      await this.broadcast(event, text, actions);
      return;
    }

    const now = this.clock.now();
    let delivered = 0;
    let failures = 0;

    await forEachWithConcurrency(recipients, SEND_CONCURRENCY, async (recipient) => {
      if (await this.isSuppressed(recipient, sensorId, severity, now)) return;
      try {
        await this.notifier.notifyUser(recipient.telegramId, { text, asFile: false, actions });
        delivered += 1;
      } catch (error) {
        failures += 1;
        this.logger.warn(
          `Notification to ${recipient.telegramId} failed: ${(error as Error).message}`,
        );
      }
    });

    // Every eligible delivery failed (e.g. notifier down mid-send) → keep the
    // event queued so the drain retries it.
    if (delivered === 0 && failures > 0) return;

    await this.markSent(event);
  }

  /**
   * Motion-event notification (spec 19, 20). Photo + caption to every
   * recipient minus those globally muted or in quiet hours (motion is
   * `info` severity). Best-effort and ephemeral — unlike sensor events it is
   * not queued for the offline drain. When no per-user recipients exist
   * (mock/dev) it broadcasts so dev output still surfaces the event.
   */
  async notifyMotion(
    cameraName: string,
    at: Date,
    photo: Buffer | null,
    cameraId?: string,
  ): Promise<void> {
    if (!this.notifier.isReady()) return;

    const caption = formatMotionCaption(cameraName, at, this.options.timezone);
    const recipients = await this.recipients.listRecipients();

    if (recipients.length === 0) {
      try {
        await this.notifier.notify({ text: caption, asFile: false });
      } catch (error) {
        this.logger.warn(`Motion broadcast failed: ${(error as Error).message}`);
      }
      return;
    }

    const now = this.clock.now();
    await forEachWithConcurrency(recipients, SEND_CONCURRENCY, async (recipient) => {
      if (await this.isMotionSuppressed(recipient, cameraName, now, cameraId)) return;
      try {
        if (photo) {
          await this.notifier.notifyUserPhoto(recipient.telegramId, { buffer: photo, caption });
        } else {
          await this.notifier.notifyUser(recipient.telegramId, { text: caption, asFile: false });
        }
      } catch (error) {
        this.logger.warn(
          `Motion notification to ${recipient.telegramId} failed: ${(error as Error).message}`,
        );
      }
    });
  }

  private async isMotionSuppressed(
    recipient: NotificationRecipient,
    cameraName: string,
    now: Date,
    cameraId?: string,
  ): Promise<boolean> {
    if (recipient.muted) return true;
    if (await this.recipients.isSensorMuted(recipient.telegramId, cameraName)) {
      return true;
    }
    if (
      cameraId &&
      cameraId !== cameraName &&
      (await this.recipients.isSensorMuted(recipient.telegramId, cameraId))
    ) {
      return true;
    }
    const lookup = await this.sensors.findByName(cameraName);
    if (
      lookup?.kind === 'active' &&
      lookup.sensor.id !== cameraName &&
      lookup.sensor.id !== cameraId &&
      (await this.recipients.isSensorMuted(recipient.telegramId, lookup.sensor.id))
    ) {
      return true;
    }
    return isInQuietHours(recipient, now, this.options.timezone);
  }

  private async isSuppressed(
    recipient: NotificationRecipient,
    sensorId: string,
    severity: SensorSeverity,
    now: Date,
  ): Promise<boolean> {
    if (recipient.muted) return true;
    if (await this.recipients.isSensorMuted(recipient.telegramId, sensorId)) {
      return true;
    }
    // Quiet hours always silence `info`. `warning` always passes. `critical`
    // is silenced only when the operator disables critical-ignores-quiet-hours.
    const quietable =
      severity === 'info' ||
      (severity === 'critical' && !this.options.criticalIgnoresQuietHours);
    if (quietable && isInQuietHours(recipient, now, this.options.timezone)) {
      return true;
    }
    return false;
  }

  private async broadcast(
    event: QueuedEvent,
    text?: string,
    actions?: { text: string; callbackData: string }[][],
  ): Promise<void> {
    try {
      await this.notifier.notify({
        text: text ?? fallbackText(event),
        asFile: false,
        actions,
      });
    } catch (error) {
      this.logger.warn(`Broadcast failed, will retry: ${(error as Error).message}`);
      return; // leave queued for the drain
    }
    await this.markSent(event);
  }

  private async markSent(event: QueuedEvent): Promise<void> {
    await this.events.markSent([event.id], this.clock.now());
  }
}

function readSeverity(event: QueuedEvent): SensorSeverity | null {
  const value = (event.payload as { severity?: unknown } | null)?.severity;
  return value === 'warning' || value === 'critical' || value === 'info'
    ? value
    : null;
}

function readName(event: QueuedEvent): string | null {
  const value = (event.payload as { name?: unknown } | null)?.name;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function fallbackText(event: QueuedEvent): string {
  const newValue = (event.payload as { newValue?: unknown } | null)?.newValue;
  const subject = readName(event) ?? event.sensorId ?? 'system';
  return `${subject}: ${newValue === undefined ? event.type : stringifyValue(newValue)}`;
}

function stringifyValue(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    default:
      return JSON.stringify(value) ?? '[unserializable]';
  }
}

function isActiveValue(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}
