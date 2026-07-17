import { describe, expect, it } from 'vitest';
import type { Sensor } from '../../../src/sensors/domain/sensor';
import type { SensorDashboardPage } from '../../../src/sensors/domain/sensor-dashboard-page';
import type { HomeScreen } from '../../../src/telegram/application/home-screen';
import type { HomeSummary } from '../../../src/telegram/application/get-home-summary.use-case';
import type { NotificationTargetPage } from '../../../src/telegram/application/notification-target-directory.service';
import type { NotificationScreen } from '../../../src/telegram/application/get-notification-screen.use-case';
import { parseHomeCallback, type HomeAction } from '../../../src/telegram/domain/home-callback';
import type { HomeIdentity } from '../../../src/telegram/domain/home-session';
import { catalogs } from '../../../src/locales/catalog';
import { renderHomeMessage } from '../../../src/telegram/interfaces/home-renderer';

const identity: Omit<HomeIdentity, 'messageId'> = {
  userId: 7,
  chatId: 9,
  token: 'AbCdEfGhIjKlMnO_',
  revision: 36,
};

function sensor(id: string, name = id): Sensor {
  return {
    id,
    name,
    type: 'digital',
    config: {},
    enabled: true,
    debounceMs: 0,
    severity: 'warning',
    lastValue: 'true',
    lastValueAt: new Date('2030-01-01T12:00:00.000Z'),
  };
}

function summary(overrides: Partial<HomeSummary> = {}): HomeSummary {
  const attention = [
    { sensor: sensor('a', 'Front door'), level: 'critical' as const, active: true },
    { sensor: sensor('b', 'Kitchen leak'), level: 'warning' as const, active: true },
    { sensor: sensor('c', 'Bedroom window'), level: 'warning' as const, active: true },
  ];
  return {
    verdict: 'attention',
    sensors: attention,
    attention,
    attentionTotal: attention.length,
    knownCount: attention.length,
    unknownCount: 0,
    health: {
      completedAt: new Date('2030-01-01T12:00:00.000Z'),
      enabledSensorIds: ['a', 'b', 'c'],
      onlineSensorIds: ['a', 'b', 'c'],
      missingSensorIds: [],
      failedSensorIds: [],
      timedOutSensorIds: [],
      offlineSensorIds: [],
    },
    healthFresh: true,
    notificationState: { kind: 'normal' },
    ...overrides,
  };
}

function page(overrides: Partial<SensorDashboardPage> = {}): SensorDashboardPage {
  return {
    sensors: Array.from({ length: 8 }, (_, index) => sensor(String(index + 1), `Sensor ${index + 1}`)),
    requestedPage: 1,
    page: 1,
    pageCount: 3,
    total: 20,
    clamped: false,
    ...overrides,
  };
}

function sensorsScreen(overrides: Partial<Extract<HomeScreen, { kind: 'sensors' }>> = {}): HomeScreen {
  return {
    kind: 'sensors',
    summary: summary({ attentionTotal: 4 }),
    page: page(),
    checking: false,
    isAdmin: false,
    ...overrides,
  };
}

function notificationSettings(overrides: Partial<NotificationScreen> = {}): NotificationScreen {
  return {
    legacyMuted: false,
    timedPauseUntil: null,
    quietStart: null,
    quietEnd: null,
    mutedTargetCount: 0,
    undoPause: null,
    undoQuietHours: null,
    ...overrides,
  };
}

function targetPage(overrides: Partial<NotificationTargetPage> = {}): NotificationTargetPage {
  return {
    targets: Array.from({ length: 8 }, (_, index) => ({
      ref: { kind: index % 2 === 0 ? 'sensor' as const : 'camera' as const, id: `target-${index}` },
      name: `Target ${index + 1}`,
      kind: index % 2 === 0 ? 'sensor' as const : 'camera' as const,
      muted: false,
    })),
    requestedPage: 1,
    page: 1,
    pageCount: 3,
    total: 20,
    clamped: false,
    ...overrides,
  };
}

function rowLabels(rendered: ReturnType<typeof renderHomeMessage>): string[][] {
  return rendered.rows.map((row) => row.map((button) => button.text));
}

function rowActions(rendered: ReturnType<typeof renderHomeMessage>): HomeAction[][] {
  return rendered.rows.map((row) => row.map((button) => {
    const parsed = parseHomeCallback(button.callbackData);
    if (!parsed) throw new Error('Invalid callback');
    return parsed.action;
  }));
}

function shapeOf(value: unknown): unknown {
  if (typeof value === 'function') return 'function';
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]));
  }
  return typeof value;
}

describe('renderHomeMessage', () => {
  it.each([
    ['en', catalogs.en],
    ['ru', catalogs.ru],
    ['uk', catalogs.uk],
  ] as const)('keeps the Home keyboard layout stable for %s in every verdict', (_locale, catalog) => {
    for (const verdict of ['attention', 'unavailable', 'normal'] as const) {
      const rendered = renderHomeMessage(catalog, identity, {
        kind: 'home',
        summary: summary({ verdict }),
        checking: false,
      });

      expect(rendered.rows.map((row) => row.map((button) => button.text))).toEqual([
        [catalog.home.buttons.sensors, catalog.home.buttons.camera],
        [catalog.home.buttons.notifications, catalog.home.buttons.more],
        [catalog.home.buttons.checkNow],
      ]);
    }
  });

  it('renders at most eight sensor names as text, with paging before Check now and Back/Home', () => {
    const rendered = renderHomeMessage(catalogs.en, identity, sensorsScreen());

    expect(rendered.text).toContain('Sensor 1');
    expect(rendered.text).toContain('Sensor 8');
    expect(rendered.text).not.toContain('Sensor 9');
    expect(rendered.rows.map((row) => row.map((button) => button.text))).toEqual([
      [catalogs.en.home.sensors.previous, catalogs.en.home.sensors.next],
      [catalogs.en.home.buttons.checkNow],
      [catalogs.en.home.sensors.home],
    ]);
  });

  it('caps attention names, explains a clamped page, and preserves the page while checking', () => {
    const rendered = renderHomeMessage(catalogs.en, identity, sensorsScreen({
      checking: true,
      page: page({ requestedPage: 8, page: 2, clamped: true }),
    }));

    expect(rendered.text).toContain('Front door');
    expect(rendered.text).toContain('Bedroom window');
    expect(rendered.text).toContain('3 of 4 shown');
    expect(rendered.text).toContain('showing page 3');
    expect(rendered.text).toContain('Page 3 of 3');
    expect(rendered.text).toContain(catalogs.en.home.health.checking);
  });

  it('distinguishes member and administrator empty states without sensor callback buttons', () => {
    const empty = page({ sensors: [], pageCount: 0, total: 0, requestedPage: 0, page: 0 });
    const member = renderHomeMessage(catalogs.en, identity, sensorsScreen({ page: empty, isAdmin: false }));
    const admin = renderHomeMessage(catalogs.en, identity, sensorsScreen({ page: empty, isAdmin: true }));

    expect(member.text).toContain(catalogs.en.home.sensors.emptyMember);
    expect(admin.text).toContain(catalogs.en.home.sensors.emptyAdmin);
    expect(admin.text).toContain(catalogs.en.home.sensors.setupSensors);
    expect(member.rows).toEqual([
      [{ text: catalogs.en.home.buttons.checkNow, callbackData: expect.any(String) }],
      [{ text: catalogs.en.home.sensors.home, callbackData: expect.any(String) }],
    ]);
  });

  it('uses only valid bounded Home callbacks and never puts sensor names in callback data', () => {
    const rendered = renderHomeMessage(catalogs.en, identity, sensorsScreen());

    for (const callbackData of rendered.rows.flatMap((row) => row.map((button) => button.callbackData))) {
      expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64);
      expect(parseHomeCallback(callbackData)).not.toBeNull();
      expect(callbackData).not.toContain('Sensor');
    }
  });

  it('keeps the Slice 3 locale object shapes identical', () => {
    for (const key of ['notifications', 'history', 'more', 'adminTools', 'adminSensorSetup', 'adminStorage', 'adminSystem', 'adminCleanupThreshold', 'confirmation', 'cleanupResult', 'workflow'] as const) {
      expect(shapeOf(catalogs.ru.home[key])).toEqual(shapeOf(catalogs.en.home[key]));
      expect(shapeOf(catalogs.uk.home[key])).toEqual(shapeOf(catalogs.en.home[key]));
    }
  });

  it('renders notification controls in their stable rows and uses existing Undo receipts only', () => {
    const receiptId = 'QrStUvWxYz012345';
    const rendered = renderHomeMessage(catalogs.en, identity, {
      kind: 'notifications',
      settings: notificationSettings({
        timedPauseUntil: new Date('2030-01-01T16:00:00.000Z'),
        quietStart: '22:00',
        quietEnd: '07:00',
        mutedTargetCount: 2,
        undoPause: { id: receiptId, userId: 7, chatId: 9, kind: 'undo-non-critical-pause', sessionToken: null, status: 'pending', expiresAt: new Date(), payload: { foundationReceiptId: 1, expectedRevision: 1 } },
        undoQuietHours: { id: receiptId, userId: 7, chatId: 9, kind: 'undo-quiet-hours', sessionToken: null, status: 'pending', expiresAt: new Date(), payload: { start: null, end: null, expectedRevision: 1 } },
      }),
    });

    expect(rowLabels(rendered)).toEqual([
      [catalogs.en.home.notifications.preset22To07, catalogs.en.home.notifications.preset23To06, catalogs.en.home.notifications.preset00To08, catalogs.en.home.notifications.presetOff],
      [catalogs.en.home.notifications.targetSettings],
      [catalogs.en.home.notifications.resume],
      [catalogs.en.home.notifications.undoQuietHours],
      [catalogs.en.home.common.home],
    ]);
    expect(rowActions(rendered)).toEqual([
      [{ kind: 'quiet-hours', preset: '22-07' }, { kind: 'quiet-hours', preset: '23-06' }, { kind: 'quiet-hours', preset: '00-08' }, { kind: 'quiet-hours', preset: 'off' }],
      [{ kind: 'notification-targets', page: 0 }],
      [{ kind: 'undo-pause', receiptId }],
      [{ kind: 'undo-quiet-hours', receiptId }],
      [{ kind: 'home' }],
    ]);
  });

  it('renders no more than eight plain-text target labels and never encodes a target identity', () => {
    const rendered = renderHomeMessage(catalogs.en, identity, {
      kind: 'notification-targets',
      page: targetPage({ targets: [{ ref: { kind: 'sensor', id: 'private-id' }, name: '*_[Target Name](x)', kind: 'sensor', muted: false }] }),
    });

    expect(rendered.text).toContain('*_[Target Name](x)');
    expect(rowActions(rendered)).toEqual([
      [{ kind: 'notification-target', index: 0 }],
      [{ kind: 'notification-targets', page: 0 }, { kind: 'notification-targets', page: 2 }],
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
    expect(rendered.rows.flatMap((row) => row.map((button) => button.callbackData)).join('\n')).not.toContain('private-id');
    expect(rendered.rows.flatMap((row) => row.map((button) => button.callbackData)).join('\n')).not.toContain('Target Name');
    expect(rendered).not.toHaveProperty('parseMode');
  });

  it('renders a selected target mute state with a plain-text label', () => {
    const rendered = renderHomeMessage(catalogs.en, identity, {
      kind: 'notification-target',
      target: { ref: { kind: 'camera', id: 'camera-id' }, name: '[Garage]*', kind: 'camera', muted: true },
      page: 2,
    });

    expect(rendered.text).toContain('[Garage]*');
    expect(rowActions(rendered)).toEqual([
      [{ kind: 'notification-target-unmute' }],
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
  });

  it('renders duration choices and confirms a duration without promising a clock time', () => {
    const picker = renderHomeMessage(catalogs.en, identity, { kind: 'pause-duration' });
    const confirmation = renderHomeMessage(catalogs.en, identity, {
      kind: 'pause-confirmation', hours: 4, receiptId: 'QrStUvWxYz012345',
    });

    expect(rowActions(picker)).toEqual([
      [{ kind: 'pause-hours', hours: 1 }, { kind: 'pause-hours', hours: 4 }, { kind: 'pause-hours', hours: 8 }],
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
    expect(confirmation.text).toContain('4');
    expect(confirmation.text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(rowActions(confirmation)).toEqual([
      [{ kind: 'confirm-pause', receiptId: 'QrStUvWxYz012345' }],
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
  });

  it('renders canonical History, More, and admin destination layouts', () => {
    const history = renderHomeMessage(catalogs.en, identity, { kind: 'history' });
    const memberMore = renderHomeMessage(catalogs.en, identity, { kind: 'more', isAdmin: false });
    const adminMore = renderHomeMessage(catalogs.en, identity, { kind: 'more', isAdmin: true });
    const adminTools = renderHomeMessage(catalogs.en, identity, { kind: 'admin-tools' });

    expect(rowActions(history)).toEqual([
      [{ kind: 'history-logs' }, { kind: 'history-csv' }],
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
    expect(rowActions(memberMore)).toEqual([
      [{ kind: 'history' }, { kind: 'settings' }],
      [{ kind: 'help' }],
      [{ kind: 'home' }],
    ]);
    expect(rowActions(adminMore)).toEqual([
      [{ kind: 'history' }, { kind: 'settings' }],
      [{ kind: 'help' }],
      [{ kind: 'admin-tools' }],
      [{ kind: 'home' }],
    ]);
    expect(rowActions(adminTools)).toEqual([
      [{ kind: 'admin-sensor-setup' }, { kind: 'admin-storage' }],
      [{ kind: 'admin-system' }, { kind: 'invite' }],
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
  });

  it('renders exact administration action destinations and receipt-backed confirmations without Markdown', () => {
    const setup = renderHomeMessage(catalogs.en, identity, { kind: 'admin-sensor-setup' });
    const storage = renderHomeMessage(catalogs.en, identity, { kind: 'admin-storage' });
    const system = renderHomeMessage(catalogs.en, identity, { kind: 'admin-system' });
    const threshold = renderHomeMessage(catalogs.en, identity, { kind: 'admin-cleanup-threshold', autoCleanThreshold: 80 });
    const cleanup = renderHomeMessage(catalogs.en, identity, { kind: 'confirmation', action: 'cleanup', receiptId: 'QrStUvWxYz012345' });
    const restart = renderHomeMessage(catalogs.en, identity, { kind: 'confirmation', action: 'restart', receiptId: 'QrStUvWxYz012345' });

    expect(rowActions(setup)).toEqual([
      [{ kind: 'config-add' }, { kind: 'config-modify' }],
      [{ kind: 'config-remove' }, { kind: 'config-import' }],
      [{ kind: 'config-export' }],
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
    expect(rowActions(storage)).toEqual([
      [{ kind: 'drive-status' }, { kind: 'drive-connect' }],
      [{ kind: 'cleanup' }],
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
    expect(rowActions(system)).toEqual([
      [{ kind: 'system-health' }, { kind: 'system-packages' }],
      [{ kind: 'restart' }],
      [{ kind: 'admin-cleanup-threshold' }],
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
    expect(rowActions(threshold)).toEqual([
      [{ kind: 'auto-clean-threshold', value: 70 }, { kind: 'auto-clean-threshold', value: 75 }, { kind: 'auto-clean-threshold', value: 80 }],
      [{ kind: 'auto-clean-threshold', value: 85 }, { kind: 'auto-clean-threshold', value: 90 }],
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
    expect(rowActions(cleanup)[0]).toEqual([{ kind: 'confirm-cleanup', receiptId: 'QrStUvWxYz012345' }]);
    expect(rowActions(restart)[0]).toEqual([{ kind: 'confirm-restart', receiptId: 'QrStUvWxYz012345' }]);
    expect(cleanup).not.toHaveProperty('parseMode');
    expect(restart).not.toHaveProperty('parseMode');
  });

  it('uses dedicated parent labels and never renders Close Home', () => {
    const screens: HomeScreen[] = [
      { kind: 'history' },
      { kind: 'admin-tools' },
      { kind: 'admin-sensor-setup' },
      { kind: 'admin-storage' },
      { kind: 'admin-system' },
      { kind: 'admin-cleanup-threshold', autoCleanThreshold: 80 },
    ];

    for (const screen of screens) {
      const rendered = renderHomeMessage(catalogs.en, identity, screen);
      const navigation = rendered.rows.at(-1)!;
      const parent = screen.kind === 'history' || screen.kind === 'admin-tools'
        ? 'more'
        : screen.kind === 'admin-sensor-setup' || screen.kind === 'admin-storage' || screen.kind === 'admin-system'
          ? 'admin-tools'
          : 'admin-system';
      expect(navigation.map(({ text }) => text)).toEqual([
        catalogs.en.home.navigation.backTo[parent],
        catalogs.en.home.common.home,
      ]);
      expect(navigation[0]?.callbackData).not.toEqual(navigation[1]?.callbackData);
      expect(rendered.rows.flat().map(({ text }) => text)).not.toContain('✕ Close Home');
    }
  });

  it.each([
    sensorsScreen(),
    { kind: 'notifications', settings: notificationSettings() },
    { kind: 'more', isAdmin: false },
  ] satisfies HomeScreen[])('renders only Home navigation for a direct Home child: $kind', (screen) => {
    expect(rowActions(renderHomeMessage(catalogs.en, identity, screen)).at(-1)).toEqual([{ kind: 'home' }]);
  });

  it.each([
    ['executed', 80],
    ['in-progress', null],
    ['failed', null],
  ] as const)('renders plain cleanup result copy for %s', (outcome, threshold) => {
    const rendered = renderHomeMessage(catalogs.en, identity, { kind: 'cleanup-result', outcome, threshold });
    expect(rendered.text).toBeTruthy();
    expect(rendered).not.toHaveProperty('parseMode');
    expect(rowActions(rendered)).toEqual([
      [{ kind: 'back' }, { kind: 'home' }],
    ]);
  });
});
