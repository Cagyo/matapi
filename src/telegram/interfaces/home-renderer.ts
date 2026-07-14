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

interface HomeButton {
  text: string;
  callbackData: string;
}
type PendingHomeIdentity = Omit<HomeIdentity, 'messageId'> | HomeIdentity;

export function renderHomeMessage(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: HomeScreen,
): HomeRenderedMessage {
  switch (screen.kind) {
    case 'home':
      return { text: renderHomeText(catalog, screen.summary, screen.checking), rows: homeRows(catalog, identity) };
    case 'sensors':
      return { text: renderSensorsText(catalog, screen), rows: sensorRows(catalog, identity, screen) };
    case 'notifications':
      return renderNotifications(catalog, identity, screen);
    case 'notification-targets':
      return renderNotificationTargets(catalog, identity, screen);
    case 'notification-target':
      return renderNotificationTarget(catalog, identity, screen);
    case 'pause-duration':
      return renderPauseDuration(catalog, identity);
    case 'pause-confirmation':
      return renderPauseConfirmation(catalog, identity, screen);
    case 'history':
      return renderHistory(catalog, identity);
    case 'more':
      return renderMore(catalog, identity, screen);
    case 'admin-tools':
      return renderAdminTools(catalog, identity);
    case 'admin-sensor-setup':
      return renderAdminSensorSetup(catalog, identity);
    case 'admin-storage':
      return renderAdminStorage(catalog, identity);
    case 'admin-system':
      return renderAdminSystem(catalog, identity, screen);
    case 'confirmation':
      return renderConfirmation(catalog, identity, screen);
    case 'cleanup-result':
      return renderCleanupResult(catalog, identity, screen);
  }
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
    button(catalog.home.sensors.back, identity, { kind: 'back' }),
    button(catalog.home.sensors.home, identity, { kind: 'home' }),
  ]);
  return rows;
}

function renderNotifications(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: Extract<HomeScreen, { kind: 'notifications' }>,
): HomeRenderedMessage {
  const { settings } = screen;
  const lines = [
    catalog.home.notifications.title,
    '',
    catalog.home.notifications.quietHoursSummary(settings.quietStart, settings.quietEnd),
  ];
  if (settings.legacyMuted) lines.push(catalog.home.notifications.legacyMutedSummary);
  if (settings.timedPauseUntil) lines.push(catalog.home.notifications.timedPause(settings.timedPauseUntil));
  if (settings.mutedTargetCount > 0) lines.push(catalog.home.notifications.mutedTargetsSummary(settings.mutedTargetCount));

  const rows: HomeButton[][] = [
    [
      button(catalog.home.notifications.preset22To07, identity, { kind: 'quiet-hours', preset: '22-07' }),
      button(catalog.home.notifications.preset23To06, identity, { kind: 'quiet-hours', preset: '23-06' }),
      button(catalog.home.notifications.preset00To08, identity, { kind: 'quiet-hours', preset: '00-08' }),
      button(catalog.home.notifications.presetOff, identity, { kind: 'quiet-hours', preset: 'off' }),
    ],
    [button(catalog.home.notifications.targetSettings, identity, { kind: 'notification-targets', page: 0 })],
    [settings.undoPause
      ? button(catalog.home.notifications.resume, identity, { kind: 'undo-pause', receiptId: settings.undoPause.id })
      : button(catalog.home.notifications.pause, identity, { kind: 'pause-duration' })],
  ];
  if (settings.undoQuietHours) {
    rows.push([button(catalog.home.notifications.undoQuietHours, identity, { kind: 'undo-quiet-hours', receiptId: settings.undoQuietHours.id })]);
  }
  rows.push(...backHomeRows(catalog, identity));
  return { text: lines.join('\n'), rows };
}

function renderNotificationTargets(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: Extract<HomeScreen, { kind: 'notification-targets' }>,
): HomeRenderedMessage {
  const { page } = screen;
  const targets = page.targets.slice(0, 8);
  const lines = [catalog.home.notifications.targetsTitle, ''];
  if (page.total === 0) {
    lines.push(catalog.home.notifications.targetsEmpty);
  } else {
    lines.push(catalog.home.notifications.targetsPage(page.page + 1, page.pageCount, page.total));
    lines.push(...targets.map((target) => target.name));
  }

  const rows: HomeButton[][] = targets.map((target, index) => [button(target.name, identity, { kind: 'notification-target', index })]);
  if (page.pageCount > 1) {
    const paging: HomeButton[] = [];
    if (page.page > 0) paging.push(button(catalog.home.sensors.previous, identity, { kind: 'notification-targets', page: page.page - 1 }));
    if (page.page < page.pageCount - 1) paging.push(button(catalog.home.sensors.next, identity, { kind: 'notification-targets', page: page.page + 1 }));
    if (paging.length > 0) rows.push(paging);
  }
  rows.push(...backHomeRows(catalog, identity));
  return { text: lines.join('\n'), rows };
}

function renderNotificationTarget(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: Extract<HomeScreen, { kind: 'notification-target' }>,
): HomeRenderedMessage {
  const { target } = screen;
  return {
    text: [catalog.home.notifications.targetTitle, '', target.name, target.muted ? catalog.home.notifications.targetMuted : catalog.home.notifications.targetActive].join('\n'),
    rows: [
      [target.muted
        ? button(catalog.home.notifications.unmute, identity, { kind: 'notification-target-unmute' })
        : button(catalog.home.notifications.mute, identity, { kind: 'notification-target-mute' })],
      ...backHomeRows(catalog, identity),
    ],
  };
}

function renderPauseDuration(catalog: LocaleCatalog, identity: PendingHomeIdentity): HomeRenderedMessage {
  return {
    text: [catalog.home.notifications.pauseTitle, '', catalog.home.notifications.pausePrompt].join('\n'),
    rows: [
      [1, 4, 8].map((hours) => button(catalog.home.notifications.pauseHours(hours), identity, { kind: 'pause-hours', hours: hours as 1 | 4 | 8 })),
      ...backHomeRows(catalog, identity),
    ],
  };
}

function renderPauseConfirmation(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: Extract<HomeScreen, { kind: 'pause-confirmation' }>,
): HomeRenderedMessage {
  return {
    text: catalog.home.notifications.pauseConfirmation(screen.hours),
    rows: [
      [button(catalog.home.notifications.confirmPause, identity, { kind: 'confirm-pause', receiptId: screen.receiptId })],
      ...backHomeRows(catalog, identity),
    ],
  };
}

function renderHistory(catalog: LocaleCatalog, identity: PendingHomeIdentity): HomeRenderedMessage {
  return {
    text: catalog.home.history.title,
    rows: [
      [button(catalog.home.history.logs, identity, { kind: 'history-logs' }), button(catalog.home.history.exportCsv, identity, { kind: 'history-csv' })],
      ...backHomeRows(catalog, identity),
    ],
  };
}

function renderMore(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: Extract<HomeScreen, { kind: 'more' }>,
): HomeRenderedMessage {
  const rows: HomeButton[][] = [
    [button(catalog.home.more.history, identity, { kind: 'history' }), button(catalog.home.more.settings, identity, { kind: 'settings' })],
    [button(catalog.home.more.help, identity, { kind: 'help' }), button(catalog.home.more.close, identity, { kind: 'close' })],
  ];
  if (screen.isAdmin) rows.push([button(catalog.home.more.adminTools, identity, { kind: 'admin-tools' })]);
  rows.push(...backHomeRows(catalog, identity));
  return { text: catalog.home.more.title, rows };
}

function renderAdminTools(catalog: LocaleCatalog, identity: PendingHomeIdentity): HomeRenderedMessage {
  return {
    text: catalog.home.adminTools.title,
    rows: [
      [button(catalog.home.adminTools.sensorSetup, identity, { kind: 'admin-sensor-setup' }), button(catalog.home.adminTools.storage, identity, { kind: 'admin-storage' })],
      [button(catalog.home.adminTools.system, identity, { kind: 'admin-system' }), button(catalog.home.adminTools.invite, identity, { kind: 'invite' })],
      ...backHomeRows(catalog, identity),
    ],
  };
}

function renderAdminSensorSetup(catalog: LocaleCatalog, identity: PendingHomeIdentity): HomeRenderedMessage {
  return {
    text: catalog.home.adminSensorSetup.title,
    rows: [
      [button(catalog.home.adminSensorSetup.add, identity, { kind: 'config-add' }), button(catalog.home.adminSensorSetup.modify, identity, { kind: 'config-modify' })],
      [button(catalog.home.adminSensorSetup.remove, identity, { kind: 'config-remove' }), button(catalog.home.adminSensorSetup.import, identity, { kind: 'config-import' }), button(catalog.home.adminSensorSetup.export, identity, { kind: 'config-export' })],
      ...backHomeRows(catalog, identity),
    ],
  };
}

function renderAdminStorage(catalog: LocaleCatalog, identity: PendingHomeIdentity): HomeRenderedMessage {
  return {
    text: catalog.home.adminStorage.title,
    rows: [
      [button(catalog.home.adminStorage.driveStatus, identity, { kind: 'drive-status' }), button(catalog.home.adminStorage.connectDrive, identity, { kind: 'drive-connect' })],
      [button(catalog.home.adminStorage.cleanup, identity, { kind: 'cleanup' })],
      ...backHomeRows(catalog, identity),
    ],
  };
}

function renderAdminSystem(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: Extract<HomeScreen, { kind: 'admin-system' }>,
): HomeRenderedMessage {
  const thresholdRows: HomeButton[][] = [[70, 75, 80], [85, 90]].map((values) => values.map((value) => button(
    catalog.home.adminSystem.threshold(value, screen.autoCleanThreshold), identity, { kind: 'auto-clean-threshold', value: value as 70 | 75 | 80 | 85 | 90 },
  )));
  return {
    text: catalog.home.adminSystem.title,
    rows: [
      [button(catalog.home.adminSystem.health, identity, { kind: 'system-health' }), button(catalog.home.adminSystem.packages, identity, { kind: 'system-packages' })],
      [button(catalog.home.adminSystem.restart, identity, { kind: 'restart' })],
      ...thresholdRows,
      ...backHomeRows(catalog, identity),
    ],
  };
}

function renderConfirmation(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: Extract<HomeScreen, { kind: 'confirmation' }>,
): HomeRenderedMessage {
  const isCleanup = screen.action === 'cleanup';
  return {
    text: isCleanup ? catalog.home.confirmation.cleanup : catalog.home.confirmation.restart,
    rows: [
      [isCleanup
        ? button(catalog.home.confirmation.confirmCleanup, identity, { kind: 'confirm-cleanup', receiptId: screen.receiptId })
        : button(catalog.home.confirmation.confirmRestart, identity, { kind: 'confirm-restart', receiptId: screen.receiptId })],
      ...backHomeRows(catalog, identity),
    ],
  };
}

function renderCleanupResult(
  catalog: LocaleCatalog,
  identity: PendingHomeIdentity,
  screen: Extract<HomeScreen, { kind: 'cleanup-result' }>,
): HomeRenderedMessage {
  const text = screen.outcome === 'executed'
    ? catalog.home.cleanupResult.executed(screen.threshold)
    : screen.outcome === 'in-progress'
      ? catalog.home.cleanupResult.inProgress
      : catalog.home.cleanupResult.failed;
  return { text, rows: backHomeRows(catalog, identity) };
}

function backHomeRows(catalog: LocaleCatalog, identity: PendingHomeIdentity): HomeButton[][] {
  return [[
    button(catalog.home.common.back, identity, { kind: 'back' }),
    button(catalog.home.common.home, identity, { kind: 'home' }),
  ]];
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
