import { describe, expect, it, vi } from 'vitest';
import { DebounceService } from '../../../src/events/application/debounce.service';
import { NotificationService } from '../../../src/events/application/notification.service';
import { ClockPort } from '../../../src/events/domain/ports/clock.port';
import {
  NotificationMessage,
  NotificationPhoto,
  NotifierPort,
} from '../../../src/events/domain/ports/notifier.port';
import {
  NotificationRecipient,
  RecipientDirectoryPort,
} from '../../../src/events/domain/ports/recipient.port';
import { QueuedEvent } from '../../../src/events/domain/queued-event.entity';
import { InMemoryEventRepository } from '../../../src/events/infrastructure/in-memory-event.repository';
import { Sensor } from '../../../src/sensors/domain/sensor';
import {
  SensorLookup,
  SensorQueryPort,
} from '../../../src/sensors/domain/ports/sensor-query.port';

function makeSensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    id: 'front_door',
    name: 'front_door',
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 10_000,
    severity: 'info',
    lastValue: null,
    lastValueAt: null,
    ...overrides,
  };
}

class StubSensorQuery implements SensorQueryPort {
  constructor(private readonly sensor: Sensor | null) {}
  async listEnabled(): Promise<Sensor[]> {
    return this.sensor ? [this.sensor] : [];
  }
  async findById(): Promise<Sensor | null> {
    return this.sensor;
  }
  async findByIdIncludingArchived(): Promise<SensorLookup | null> {
    return this.sensor ? { kind: 'active', sensor: this.sensor } : null;
  }
  async findByName(): Promise<SensorLookup | null> {
    return this.sensor ? { kind: 'active', sensor: this.sensor } : null;
  }
  async listHistoryTargets(input: { page: number; pageSize: number }) {
    return { targets: [], page: input.page, pageCount: 0 };
  }
}

class FakeNotifier implements NotifierPort {
  ready = true;
  fail = false;
  readonly userSends: { telegramId: number; message: NotificationMessage }[] = [];
  readonly broadcasts: NotificationMessage[] = [];
  readonly photoSends: { telegramId: number; photo: NotificationPhoto }[] = [];

  isReady(): boolean {
    return this.ready;
  }
  async notify(message: NotificationMessage): Promise<void> {
    if (this.fail) throw new Error('telegram offline');
    this.broadcasts.push(message);
  }
  async notifyUser(telegramId: number, message: NotificationMessage): Promise<void> {
    if (this.fail) throw new Error('telegram offline');
    this.userSends.push({ telegramId, message });
  }
  async notifyUserPhoto(telegramId: number, photo: NotificationPhoto): Promise<void> {
    if (this.fail) throw new Error('telegram offline');
    this.photoSends.push({ telegramId, photo });
  }
}

class FakeDirectory implements RecipientDirectoryPort {
  /** Counts per-sensor-mute lookups so tests can prove the critical path skips them. */
  sensorMuteChecks = 0;
  constructor(
    private readonly recipients: NotificationRecipient[],
    private readonly sensorMutes: { telegramId: number; sensorId: string }[] = [],
  ) {}
  async listRecipients(): Promise<NotificationRecipient[]> {
    return this.recipients;
  }
  async isSensorMuted(telegramId: number, sensorId: string): Promise<boolean> {
    this.sensorMuteChecks += 1;
    return this.sensorMutes.some(
      (m) => m.telegramId === telegramId && m.sensorId === sensorId,
    );
  }
}

const FIXED_NOW = new Date('2026-07-01T12:00:00Z'); // 15:00 Kyiv (summer)
const TZ = 'Europe/Kyiv';

function recipient(overrides: Partial<NotificationRecipient> = {}): NotificationRecipient {
  return {
    telegramId: 1,
    muted: false,
    nonCriticalPausedUntil: null,
    quietStart: null,
    quietEnd: null,
    ...overrides,
  };
}

const ACTIVE_PAUSE = new Date('2026-07-01T13:00:00Z'); // 1h after FIXED_NOW
const EXPIRED_PAUSE = new Date('2026-07-01T11:00:00Z'); // 1h before FIXED_NOW

async function setup(opts: {
  sensor?: Sensor | null;
  recipients?: NotificationRecipient[];
  sensorMutes?: { telegramId: number; sensorId: string }[];
}) {
  const repo = new InMemoryEventRepository();
  const sensor = opts.sensor === undefined ? makeSensor() : opts.sensor;
  const sensorQuery = new StubSensorQuery(sensor);
  const notifier = new FakeNotifier();
  const directory = new FakeDirectory(opts.recipients ?? [], opts.sensorMutes ?? []);
  const clock: ClockPort = { now: () => FIXED_NOW };
  const debounce = new DebounceService(sensorQuery, clock);
  const service = new NotificationService(
    notifier,
    directory,
    sensorQuery,
    repo,
    clock,
    { timezone: TZ },
    debounce,
  );
  return { repo, notifier, service, directory, debounce };
}

async function enqueueStateChange(
  repo: InMemoryEventRepository,
  newValue: unknown = true,
): Promise<QueuedEvent> {
  return repo.enqueue({
    sensorId: 'front_door',
    type: 'state_change',
    payload: { newValue, name: 'front_door', severity: 'info' },
    createdAt: FIXED_NOW,
  });
}

describe('NotificationService', () => {
  it('delivers to every eligible recipient and marks the event sent', async () => {
    const { repo, notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 }), recipient({ telegramId: 2 })],
    });
    const event = await enqueueStateChange(repo);

    await service.process(event);

    expect(notifier.userSends.map((s) => s.telegramId).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(notifier.userSends[0].message.text).toBe('🚪 front_door: OPENED');
    expect(repo.sentAtFor(event.id)).toBe(FIXED_NOW);
  });

  it('skips globally muted recipients', async () => {
    const { repo, notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1, muted: true }), recipient({ telegramId: 2 })],
    });
    await service.process(await enqueueStateChange(repo));

    expect(notifier.userSends.map((s) => s.telegramId)).toEqual([2]);
  });

  it('skips recipients who muted the specific sensor', async () => {
    const { repo, notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 }), recipient({ telegramId: 2 })],
      sensorMutes: [{ telegramId: 1, sensorId: 'front_door' }],
    });
    await service.process(await enqueueStateChange(repo));

    expect(notifier.userSends.map((s) => s.telegramId)).toEqual([2]);
  });

  it('suppresses info events during quiet hours', async () => {
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ severity: 'info' }),
      // 15:00 Kyiv falls inside 14:00–16:00.
      recipients: [recipient({ telegramId: 1, quietStart: '14:00', quietEnd: '16:00' })],
    });
    await service.process(await enqueueStateChange(repo));

    expect(notifier.userSends).toHaveLength(0);
  });

  it('still delivers warning events during quiet hours', async () => {
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ severity: 'warning' }),
      recipients: [recipient({ telegramId: 1, quietStart: '14:00', quietEnd: '16:00' })],
    });
    await service.process(await enqueueStateChange(repo));

    expect(notifier.userSends.map((s) => s.message.text)).toEqual([
      '🚪 front_door: OPENED ⚠️',
    ]);
  });

  it('attaches a direct logs action to a triggered alarm', async () => {
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ config: { stepType: 'alarm' } }),
      recipients: [recipient()],
    });

    await service.process(await enqueueStateChange(repo, true));

    expect(notifier.userSends[0].message).toMatchObject({
      text: '🚨 *CRITICAL ALARM:* front_door is now *Alarm*!',
      actions: [[{ text: '📋 View Logs', callbackData: 'logs:id:front_door' }]],
    });
  });

  it('delivers a flapping fault with a direct logs action during quiet hours', async () => {
    const { repo, notifier, service } = await setup({
      recipients: [recipient({ quietStart: '14:00', quietEnd: '16:00' })],
    });
    const event = await repo.enqueue({
      sensorId: 'front_door',
      type: 'system',
      payload: { newValue: 'flapping_fault', name: 'front_door', severity: 'info' },
      createdAt: FIXED_NOW,
    });

    await service.process(event);

    expect(notifier.userSends[0].message).toMatchObject({
      text: '⚠️ *FAULT:* Sensor *front_door* switched to polled sampling due to flapping!',
      actions: [[{ text: '📋 View Logs', callbackData: 'logs:id:front_door' }]],
    });
  });

  it('uses the stable sensor ID for long sensor-name alert callbacks', async () => {
    const sensorId = '12345678-1234-4123-8123-123456789abc';
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({
        id: sensorId,
        name: 'a'.repeat(60),
        config: { stepType: 'alarm' },
      }),
      recipients: [recipient()],
    });

    await service.process(await enqueueStateChange(repo, true));

    const callbackData = notifier.userSends[0].message.actions?.[0][0].callbackData;
    expect(callbackData).toBe(`logs:id:${sensorId}`);
    expect(Buffer.byteLength(callbackData ?? '', 'utf8')).toBeLessThanOrEqual(64);
  });

  it('delivers an alert without an action when a legacy sensor ID exceeds callback limits', async () => {
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({
        id: 'x'.repeat(65),
        config: { stepType: 'alarm' },
      }),
      recipients: [recipient()],
    });

    await service.process(await enqueueStateChange(repo, true));

    expect(notifier.userSends[0].message.text).toContain('CRITICAL ALARM');
    expect(notifier.userSends[0].message.actions).toBeUndefined();
  });

  it('keeps the direct logs action at the exact 64-byte callback limit', async () => {
    const sensorId = 'x'.repeat(56); // `logs:id:` adds 8 bytes.
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ id: sensorId, config: { stepType: 'alarm' } }),
      recipients: [recipient()],
    });

    await service.process(await enqueueStateChange(repo, true));

    expect(notifier.userSends[0].message.actions?.[0][0].callbackData).toBe(`logs:id:${sensorId}`);
  });

  it('delivers a flapping fault without an action when a multibyte ID exceeds callback limits', async () => {
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ id: '🔐'.repeat(15) }),
      recipients: [recipient()],
    });
    const event = await repo.enqueue({
      sensorId: 'front_door',
      type: 'system',
      payload: { newValue: 'flapping_fault', name: 'front_door', severity: 'info' },
      createdAt: FIXED_NOW,
    });

    await service.process(event);

    expect(notifier.userSends[0].message.text).toContain('FAULT');
    expect(notifier.userSends[0].message.actions).toBeUndefined();
  });

  it('debounces a repeated identical state change and marks it sent without sending', async () => {
    const { repo, notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 })],
    });

    await service.process(await enqueueStateChange(repo, true));
    expect(notifier.userSends).toHaveLength(1);

    const repeat = await enqueueStateChange(repo, true);
    await service.process(repeat);

    expect(notifier.userSends).toHaveLength(1); // suppressed
    expect(repo.sentAtFor(repeat.id)).toBe(FIXED_NOW); // but marked sent
  });

  it('leaves the event queued when the notifier is offline', async () => {
    const { repo, notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 })],
    });
    notifier.ready = false;
    const event = await enqueueStateChange(repo);

    await service.process(event);

    expect(notifier.userSends).toHaveLength(0);
    expect(repo.sentAtFor(event.id)).toBeNull();
  });

  it('broadcasts when there are no per-user recipients', async () => {
    const { repo, notifier, service } = await setup({ recipients: [] });
    const event = await enqueueStateChange(repo);

    await service.process(event);

    expect(notifier.broadcasts.map((b) => b.text)).toEqual(['🚪 front_door: OPENED']);
    expect(repo.sentAtFor(event.id)).toBe(FIXED_NOW);
  });

  it('keeps the event queued when every eligible delivery fails', async () => {
    const { repo, notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 })],
    });
    notifier.fail = true;
    const event = await enqueueStateChange(repo);

    await service.process(event);

    expect(repo.sentAtFor(event.id)).toBeNull();
  });

  it.each([
    { label: 'legacy mute', overrides: { muted: true } },
    { label: 'quiet hours', overrides: { quietStart: '14:00', quietEnd: '16:00' } },
    {
      label: 'legacy mute and quiet hours stacked',
      overrides: { muted: true, quietStart: '14:00', quietEnd: '16:00' },
    },
  ])('delivers a critical alarm despite $label', async ({ overrides }) => {
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ severity: 'critical' }),
      recipients: [recipient({ telegramId: 1, ...overrides })],
    });
    await service.process(await enqueueStateChange(repo));
    expect(notifier.userSends).toHaveLength(1);
  });

  it('delivers a critical alarm to a recipient who muted the sensor, without any per-sensor lookup', async () => {
    const { repo, notifier, service, directory } = await setup({
      sensor: makeSensor({ severity: 'critical' }),
      recipients: [recipient({ telegramId: 1 })],
      sensorMutes: [{ telegramId: 1, sensorId: 'front_door' }],
    });

    await service.process(await enqueueStateChange(repo));

    expect(notifier.userSends.map((s) => s.telegramId)).toEqual([1]);
    // Critical bypass is evaluated before any per-target query.
    expect(directory.sensorMuteChecks).toBe(0);
  });

  it('never debounces critical alarms: a re-asserted identical critical state change delivers every time', async () => {
    const { repo, notifier, service, debounce } = await setup({
      sensor: makeSensor({ severity: 'critical' }),
      recipients: [recipient({ telegramId: 1 })],
    });
    const shouldNotify = vi.spyOn(debounce, 'shouldNotify');

    await service.process(await enqueueStateChange(repo, true));
    await service.process(await enqueueStateChange(repo, true));

    expect(notifier.userSends).toHaveLength(2);
    // Debounce is never consulted on the critical path — it neither reads nor
    // updates the marker, so a held-active alarm is never silently dropped.
    expect(shouldNotify).not.toHaveBeenCalled();
  });

  it('broadcasts a fully-suppressible non-critical event when there are no recipients', async () => {
    // Documents that the per-recipient suppression matrix does not govern the
    // no-recipient broadcast fallback: an info event that any registered user
    // would have had suppressed still reaches the shared chat.
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ severity: 'info' }),
      recipients: [],
    });
    const event = await enqueueStateChange(repo);

    await service.process(event);

    expect(notifier.broadcasts).toHaveLength(1);
    expect(repo.sentAtFor(event.id)).toBe(FIXED_NOW);
  });

  it('suppresses a warning for a user with an active timed pause but not others', async () => {
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ severity: 'warning' }),
      recipients: [
        recipient({ telegramId: 1, nonCriticalPausedUntil: ACTIVE_PAUSE }),
        recipient({ telegramId: 2 }),
      ],
    });

    await service.process(await enqueueStateChange(repo));

    expect(notifier.userSends.map((s) => s.telegramId)).toEqual([2]);
  });

  it('suppresses an info event for a user with an active timed pause', async () => {
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ severity: 'info' }),
      recipients: [recipient({ telegramId: 1, nonCriticalPausedUntil: ACTIVE_PAUSE })],
    });

    await service.process(await enqueueStateChange(repo));

    expect(notifier.userSends).toHaveLength(0);
  });

  it('delivers to a user whose timed pause has already expired', async () => {
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ severity: 'info' }),
      recipients: [recipient({ telegramId: 1, nonCriticalPausedUntil: EXPIRED_PAUSE })],
    });

    await service.process(await enqueueStateChange(repo));

    expect(notifier.userSends.map((s) => s.telegramId)).toEqual([1]);
  });

  it('delivers a critical alarm despite an active timed pause stacked with every control', async () => {
    const { repo, notifier, service } = await setup({
      sensor: makeSensor({ severity: 'critical' }),
      recipients: [
        recipient({
          telegramId: 1,
          muted: true,
          nonCriticalPausedUntil: ACTIVE_PAUSE,
          quietStart: '14:00',
          quietEnd: '16:00',
        }),
      ],
      sensorMutes: [{ telegramId: 1, sensorId: 'front_door' }],
    });

    await service.process(await enqueueStateChange(repo));

    expect(notifier.userSends).toHaveLength(1);
  });
});

describe('NotificationService.notifyMotion', () => {
  const MOTION_AT = new Date('2026-07-01T11:51:00Z'); // 14:51 Kyiv
  const EXPECTED_CAPTION = '📹 Motion detected | front_door | 01.07.2026 14:51';

  it('sends a photo + caption to every eligible recipient', async () => {
    const { notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 }), recipient({ telegramId: 2 })],
    });

    await service.notifyMotion('front_door', MOTION_AT, Buffer.from('jpeg'), 'front_door_cam');

    expect(notifier.photoSends.map((s) => s.telegramId).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(notifier.photoSends[0].photo.caption).toBe(EXPECTED_CAPTION);
    expect(notifier.photoSends[0].photo.buffer.toString()).toBe('jpeg');
    expect(notifier.photoSends[0].photo.actions).toEqual([
      [{ text: '📺 Watch live', callbackData: 'cam:live:front_door_cam' }],
    ]);
  });

  it('falls back to a text caption when no snapshot is available', async () => {
    const { notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 })],
    });

    await service.notifyMotion('front_door', MOTION_AT, null);

    expect(notifier.photoSends).toHaveLength(0);
    expect(notifier.userSends.map((s) => s.message.text)).toEqual([EXPECTED_CAPTION]);
  });

  it('skips globally muted recipients', async () => {
    const { notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1, muted: true }), recipient({ telegramId: 2 })],
    });

    await service.notifyMotion('front_door', MOTION_AT, Buffer.from('jpeg'));

    expect(notifier.photoSends.map((s) => s.telegramId)).toEqual([2]);
  });

  it('skips recipients who muted the camera by name', async () => {
    const { notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 }), recipient({ telegramId: 2 })],
      sensorMutes: [{ telegramId: 1, sensorId: 'front_door' }],
    });

    await service.notifyMotion('front_door', MOTION_AT, Buffer.from('jpeg'));

    expect(notifier.photoSends.map((s) => s.telegramId)).toEqual([2]);
  });

  it('skips recipients who muted the camera by ID', async () => {
    const { notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 }), recipient({ telegramId: 2 })],
      sensorMutes: [{ telegramId: 1, sensorId: 'cam_1' }],
    });

    await service.notifyMotion('front_door', MOTION_AT, Buffer.from('jpeg'), 'cam_1');

    expect(notifier.photoSends.map((s) => s.telegramId)).toEqual([2]);
  });

  it('suppresses motion for a user with an active timed pause but not others', async () => {
    const { notifier, service } = await setup({
      recipients: [
        recipient({ telegramId: 1, nonCriticalPausedUntil: ACTIVE_PAUSE }),
        recipient({ telegramId: 2 }),
      ],
    });

    await service.notifyMotion('front_door', MOTION_AT, Buffer.from('jpeg'));

    expect(notifier.photoSends.map((s) => s.telegramId)).toEqual([2]);
  });

  it('suppresses motion alerts during quiet hours (info severity)', async () => {
    const { notifier, service } = await setup({
      // FIXED_NOW is 15:00 Kyiv, inside 14:00–16:00.
      recipients: [recipient({ telegramId: 1, quietStart: '14:00', quietEnd: '16:00' })],
    });

    await service.notifyMotion('front_door', MOTION_AT, Buffer.from('jpeg'));

    expect(notifier.photoSends).toHaveLength(0);
    expect(notifier.userSends).toHaveLength(0);
  });

  it('does nothing when the notifier is offline', async () => {
    const { notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 })],
    });
    notifier.ready = false;

    await service.notifyMotion('front_door', MOTION_AT, Buffer.from('jpeg'));

    expect(notifier.photoSends).toHaveLength(0);
  });

  it('broadcasts the caption when there are no per-user recipients', async () => {
    const { notifier, service } = await setup({ recipients: [] });

    await service.notifyMotion('front_door', MOTION_AT, Buffer.from('jpeg'));

    expect(notifier.broadcasts.map((b) => b.text)).toEqual([EXPECTED_CAPTION]);
  });
});
