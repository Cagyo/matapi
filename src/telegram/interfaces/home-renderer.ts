import type { LocaleCatalog } from '../../locales/catalog';
import type { Sensor } from '../../sensors/domain/sensor';
import type { HomeScreen } from '../application/home-screen';
import type { HomeSummary } from '../application/get-home-summary.use-case';
import { encodeHomeCallback, type HomeAction } from '../domain/home-callback';
import type { HomeIdentity } from '../domain/home-session';

export interface HomeRenderedMessage {
  text: string;
  rows: readonly (readonly { text: string; callbackData: string }[])[];
}

type HomeButton = { text: string; callbackData: string };
type PendingHomeIdentity = Omit<HomeIdentity, 'messageId'> | HomeIdentity;

export function renderHomeMessage(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: HomeScreen,
): HomeRenderedMessage {
  if (screen.kind === 'home') {
    return { text: renderHomeText(catalog, screen.summary, screen.checking), rows: homeRows(catalog, identity) };
  }
  if (screen.kind !== 'sensors') {
    throw new RangeError(`Screen ${screen.kind} has no renderer in this slice`);
  }
  const text = renderSensorsText(catalog, screen);
  const rows = sensorRows(catalog, identity, screen);
  return { text, rows };
}

function renderHomeText(
  catalog: LocaleCatalog,
  summary: HomeSummary,
  checking: boolean,
): string {
  return [
    catalog.home.title,
    '',
    verdictText(catalog, summary),
    stateText(catalog, summary),
    healthText(catalog, summary, checking),
    notificationText(catalog, summary),
  ].join('\n');
}

function renderSensorsText(
  catalog: LocaleCatalog,
  screen: Extract<HomeScreen, { kind: 'sensors' }>,
): string {
  const { summary, page } = screen;
  const lines = [catalog.home.sensors.title, ''];
  const attentionNames = summary.attention.map(({ sensor }) => sensor.name);
  if (attentionNames.length > 0) {
    lines.push(catalog.home.sensors.attention(attentionNames));
    if (summary.attentionTotal > attentionNames.length) {
      lines.push(catalog.home.sensors.attentionShown(attentionNames.length, summary.attentionTotal));
    }
    lines.push('');
  }

  if (page.total === 0) {
    lines.push(screen.isAdmin ? catalog.home.sensors.emptyAdmin : catalog.home.sensors.emptyMember);
    if (screen.isAdmin) lines.push(catalog.home.sensors.setupSensors);
  } else {
    lines.push(catalog.home.sensors.page(page.page + 1, page.pageCount, page.total));
    if (page.clamped) lines.push(catalog.home.sensors.clamp(page.page + 1));
    for (const item of page.sensors) {
      lines.push(catalog.home.sensors.row(item.name, sensorState(item)));
    }
  }

  lines.push('', healthText(catalog, summary, screen.checking));
  return lines.join('\n');
}

function verdictText(catalog: LocaleCatalog, summary: HomeSummary): string {
  switch (summary.verdict) {
    case 'attention':
      return catalog.home.verdicts.attention(summary.attentionTotal);
    case 'unavailable':
      return catalog.home.verdicts.unavailable;
    case 'normal':
      return catalog.home.verdicts.normal;
  }
}

function stateText(catalog: LocaleCatalog, summary: HomeSummary): string {
  return summary.sensors.length === 0
    ? catalog.home.state.absent
    : catalog.home.state.counts(summary.knownCount, summary.unknownCount);
}

function healthText(catalog: LocaleCatalog, summary: HomeSummary, checking: boolean): string {
  const { health } = summary;
  let text: string;
  if (health === null) {
    text = catalog.home.health.absent;
  } else if (!summary.healthFresh) {
    text = catalog.home.health.stale;
  } else if (health.failedSensorIds.length > 0 || health.timedOutSensorIds.length > 0) {
    text = catalog.home.health.failed;
  } else {
    text = catalog.home.health.counts(health.onlineSensorIds.length, health.enabledSensorIds.length);
  }
  return checking ? `${text}\n${catalog.home.health.checking}` : text;
}

function notificationText(catalog: LocaleCatalog, summary: HomeSummary): string {
  switch (summary.notificationState.kind) {
    case 'normal':
      return catalog.home.notifications.normal;
    case 'quiet_hours':
      return catalog.home.notifications.quietHours(summary.notificationState.until);
    case 'timed_pause':
      return catalog.home.notifications.timedPause(summary.notificationState.until);
    case 'legacy_pause':
      return catalog.home.notifications.legacyPause;
    case 'paused_targets':
      return catalog.home.notifications.pausedTargets(summary.notificationState.count);
  }
}

function homeRows(catalog: LocaleCatalog, identity: PendingHomeIdentity): readonly HomeButton[][] {
  return [
    [button(catalog.home.buttons.sensors, identity, { kind: 'sensors', page: 0 }), button(catalog.home.buttons.camera, identity, { kind: 'camera' })],
    [button(catalog.home.buttons.notifications, identity, { kind: 'notifications' }), button(catalog.home.buttons.more, identity, { kind: 'more' })],
    [button(catalog.home.buttons.checkNow, identity, { kind: 'check' })],
  ];
}

function sensorRows(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: Extract<HomeScreen, { kind: 'sensors' }>,
): readonly HomeButton[][] {
  const rows: HomeButton[][] = [];
  const { page } = screen;
  if (page.pageCount > 1) {
    const paging: HomeButton[] = [];
    if (page.page > 0) paging.push(button(catalog.home.sensors.previous, identity, { kind: 'sensors', page: page.page - 1 }));
    if (page.page < page.pageCount - 1) paging.push(button(catalog.home.sensors.next, identity, { kind: 'sensors', page: page.page + 1 }));
    if (paging.length > 0) rows.push(paging);
  }
  rows.push([button(catalog.home.buttons.checkNow, identity, { kind: 'check' })]);
  rows.push([
    button(catalog.home.sensors.back, identity, { kind: 'home' }),
    button(catalog.home.sensors.home, identity, { kind: 'home' }),
  ]);
  return rows;
}

function button(text: string, identity: PendingHomeIdentity, action: HomeAction): HomeButton {
  return {
    text,
    callbackData: encodeHomeCallback(identity.token, identity.revision, action),
  };
}

function sensorState(sensor: Sensor): string {
  return sensor.lastValue ?? '—';
}
