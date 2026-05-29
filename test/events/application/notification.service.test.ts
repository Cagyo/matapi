import { describe, expect, it } from 'vitest';
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
  async findByName(): Promise<SensorLookup | null> {
    return this.sensor ? { kind: 'active', sensor: this.sensor } : null;
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
  constructor(
    private readonly recipients: NotificationRecipient[],
    private readonly sensorMutes: { telegramId: number; sensorId: string }[] = [],
  ) {}
  async listRecipients(): Promise<NotificationRecipient[]> {
    return this.recipients;
  }
  async isSensorMuted(telegramId: number, sensorId: string): Promise<boolean> {
    return this.sensorMutes.some(
      (m) => m.telegramId === telegramId && m.sensorId === sensorId,
    );
  }
}

const FIXED_NOW = new Date('2026-07-01T12:00:00Z'); // 15:00 Kyiv (summer)
const TZ = 'Europe/Kyiv';

function recipient(overrides: Partial<NotificationRecipient> = {}): NotificationRecipient {
  return { telegramId: 1, muted: false, quietStart: null, quietEnd: null, ...overrides };
}

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
  return { repo, notifier, service };
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

    expect(notifier.userSends.map((s) => s.telegramId)).toEqual([1, 2]);
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
});

describe('NotificationService.notifyMotion', () => {
  const MOTION_AT = new Date('2026-07-01T11:51:00Z'); // 14:51 Kyiv
  const EXPECTED_CAPTION = '📹 Motion detected | front_door | 01.07.2026 14:51';

  it('sends a photo + caption to every eligible recipient', async () => {
    const { notifier, service } = await setup({
      recipients: [recipient({ telegramId: 1 }), recipient({ telegramId: 2 })],
    });

    await service.notifyMotion('front_door', MOTION_AT, Buffer.from('jpeg'));

    expect(notifier.photoSends.map((s) => s.telegramId)).toEqual([1, 2]);
    expect(notifier.photoSends[0].photo.caption).toBe(EXPECTED_CAPTION);
    expect(notifier.photoSends[0].photo.buffer.toString()).toBe('jpeg');
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
