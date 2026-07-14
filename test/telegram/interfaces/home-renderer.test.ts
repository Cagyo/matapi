import { describe, expect, it } from 'vitest';
import type { Sensor } from '../../../src/sensors/domain/sensor';
import type { SensorDashboardPage } from '../../../src/sensors/domain/sensor-dashboard-page';
import type { HomeScreen } from '../../../src/telegram/application/home-screen';
import type { HomeSummary } from '../../../src/telegram/application/get-home-summary.use-case';
import { parseHomeCallback } from '../../../src/telegram/domain/home-callback';
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
      [catalogs.en.home.sensors.back, catalogs.en.home.sensors.home],
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
      [
        { text: catalogs.en.home.sensors.back, callbackData: expect.any(String) },
        { text: catalogs.en.home.sensors.home, callbackData: expect.any(String) },
      ],
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
});
