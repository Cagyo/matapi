import { format } from 'date-fns';
import { DbRecovery } from '../database/integrity';
import { SensorSeverity, SensorType } from '../sensors/domain/sensor';
import { ImportSummary } from '../sensors/application/import-sensors.use-case';
import { FeatureStatus } from '../features/domain/feature-status';
import { DepUpdate } from '../system/domain/ports/system-deps.port';

const DATE_FNS_FMT = 'dd.MM.yyyy HH:mm';
const DATE_FNS_FMT_SECONDS = 'dd.MM.yyyy HH:mm:ss';
const TIME_FMT = 'HH:mm';

function fmtDate(date: Date | null | undefined, withSeconds = false): string {
  if (!date) return 'never';
  return format(date, withSeconds ? DATE_FNS_FMT_SECONDS : DATE_FNS_FMT);
}

function fmtTime(date: Date | null | undefined): string {
  if (!date) return '—';
  return format(date, TIME_FMT);
}

const TYPE_ICONS: Record<SensorType, string> = {
  digital: '🚪',
  uart: '🌬️',
  mqtt: '📡',
  camera: '📷',
};

export interface StatusRow {
  name: string;
  type: SensorType;
  lastValue: string | null;
  lastValueAt: Date | null;
  online: boolean;
  /** Co2 ppm classification (uart only). */
  thresholdLevel?: 'normal' | 'warning' | 'critical';
}

export interface HealthSnapshotView {
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  cpuTempC: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  uptimeSec: number;
  dbSizeBytes: number | null;
  botLastUpdateAgoSec: number | null;
  sensorsOnline: number;
  sensorsTotal: number;
}

export interface LogLineView {
  level: string;
  message: string;
  timestamp: Date;
}

export interface MotionEventView {
  id: number;
  startedAt: Date | null;
  durationSec: number | null;
  hasSnapshot: boolean;
}

export interface CameraStatusView {
  running: boolean;
  lastEventAt: Date | null;
  localStorageBytes: number | null;
  eventsToday: number;
}

export interface GdriveStatusView {
  usedBytes: number;
  totalBytes: number;
  lastUploadAt: Date | null;
  pendingUploads: number;
  failedUploads: number;
  lastError: string | null;
  cleanupMinAgeDays: number;
}

export interface SystemOnlineView {
  sensorsOnline: number;
  sensorsTotal: number;
  dbRecovery: DbRecovery;
  clockSynchronized: boolean;
  now: Date;
}

function gb(bytes: number | null): string {
  if (bytes === null) return 'N/A';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function mb(bytes: number | null): string {
  if (bytes === null) return 'N/A';
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function percent(used: number | null, total: number | null): string {
  if (used === null || total === null || total <= 0) return 'N/A';
  return `${Math.round((used / total) * 100)}%`;
}

function fmtUptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function fmtDigital(value: string | null): string {
  if (value === null) return 'unknown';
  if (value === 'true' || value === '1') return 'OPEN';
  if (value === 'false' || value === '0') return 'CLOSED';
  return value.toUpperCase();
}

function fmtUart(value: string | null, level?: StatusRow['thresholdLevel']): string {
  if (value === null) return 'unknown';
  const marker =
    level === 'critical' ? ' ❌' : level === 'warning' ? ' ⚠️' : level ? ' ✅' : '';
  return `${value} ppm${marker}`;
}

function fmtRowValue(row: StatusRow): string {
  switch (row.type) {
    case 'digital':
      return fmtDigital(row.lastValue);
    case 'uart':
      return fmtUart(row.lastValue, row.thresholdLevel);
    default:
      return row.lastValue ?? 'unknown';
  }
}

export const en = {
  common: {
    adminRequired: '❌ Admin access required',
    error: (action: string, reason: string) => `❌ Failed to ${action}: ${reason}`,
    interrupted: 'Previous operation was interrupted. Please start again.',
  },
  claim: {
    success: '✅ You are now the admin of this Home Worker.',
    alreadyClaimed: '❌ This Home Worker already has an admin.',
  },
  users: {
    inviteIssued: (code: string) =>
      `🔗 Invite code: ${code}\nShare this with the new user. They should send:\n/start ${code}`,
    inviteFailed: '❌ Failed to issue invite code',
    startNoCode: 'Send /start <invite_code> to register',
    invalidCode: '❌ Invalid invite code',
    codeUsed: '❌ This invite code has already been used',
    alreadyRegistered: "You're already registered",
    welcomed: (name: string) => `✅ Welcome, ${name}! You're registered as a user.`,
    joinedNotice: (name: string) => `👤 ${name} joined using your invite code.`,
    userNotFound: '❌ User not found',
    alreadyAdmin: (name: string) => `ℹ️ ${name} is already an admin`,
    alreadyUser: (name: string) => `ℹ️ ${name} is already a regular user`,
    promoted: (name: string) => `✅ ${name} promoted to admin.`,
    promotedNotice: (admin: string) =>
      `🎉 You've been promoted to admin by ${admin}.`,
    demoted: (name: string) => `✅ ${name} demoted to user.`,
    demotedNotice: (admin: string) => `You've been demoted to user by ${admin}.`,
    promoteFailed: '❌ Failed to promote user',
    demoteFailed: '❌ Failed to demote user',
    registerFailed: '❌ Failed to register',
    missingTarget: (cmd: string) => `❌ Usage: /${cmd} <username_or_name>`,
  },
  feature: {
    usage: '❌ Usage: /feature enable|disable|list [feature_name]',
    listHeader: '🔧 Features',
    listLine(f: FeatureStatus): string {
      const icon = !f.installed ? '⬜' : f.enabled ? '✅' : '❌';
      const state = f.enabled ? 'enabled' : 'disabled';
      const install = f.installed ? 'installed' : 'not installed';
      return `${icon} ${f.name} — ${state} (${install})`;
    },
    enabled: (name: string) =>
      `✅ Feature '${name}' enabled.\nℹ️ Restart the worker to fully load it.`,
    disabled: (name: string) =>
      `✅ Feature '${name}' disabled.\nℹ️ Restart the worker to fully unload it.`,
    unknown: (name: string) =>
      `❌ Unknown feature '${name}'. Use /feature list.`,
    notInstalled: (name: string) =>
      `❌ Feature '${name}' requires system dependencies. Re-run the install script with ${name} enabled.`,
    alreadyEnabled: (name: string) => `ℹ️ Feature '${name}' is already enabled`,
    alreadyDisabled: (name: string) =>
      `ℹ️ Feature '${name}' is already disabled`,
    enableFailed: '❌ Failed to enable feature',
    disableFailed: '❌ Failed to disable feature',
    listFailed: '❌ Failed to list features',
  },
  status: {
    header: '📊 System Status',
    none: 'No sensors configured. Use /config to add sensors.',
    line(row: StatusRow): string {
      const icon = TYPE_ICONS[row.type] ?? '•';
      const value = fmtRowValue(row);
      let suffix = '';
      if (!row.online) {
        suffix = ' ⚠️ offline';
      } else if (
        row.type === 'digital' &&
        (row.lastValue === 'true' || row.lastValue === '1') &&
        row.lastValueAt
      ) {
        suffix = ` ⚠️ (since ${fmtTime(row.lastValueAt)})`;
      }
      return `${icon} ${row.name}: ${value}${suffix}`;
    },
    footer(allOnline: boolean, offlineCount: number, now: Date): string {
      const head = allOnline
        ? '📡 All systems online'
        : `⚠️ ${offlineCount} sensor${offlineCount === 1 ? '' : 's'} offline`;
      return `${head} | ${fmtDate(now)}`;
    },
    readFailed: '❌ Failed to read sensor status',
  },
  ping: {
    pong: (ms: number) => `🏓 Pong! (${ms}ms)`,
  },
  health: {
    header: '🏥 System Health',
    body(snap: HealthSnapshotView): string {
      const lines = [
        `💾 Disk: ${gb(snap.diskUsedBytes)} / ${gb(snap.diskTotalBytes)} (${percent(
          snap.diskUsedBytes,
          snap.diskTotalBytes,
        )})`,
        `🌡️ CPU Temp: ${snap.cpuTempC !== null ? `${Math.round(snap.cpuTempC)}°C` : 'N/A'}`,
        `🧠 Memory: ${mb(snap.memoryUsedBytes)} / ${mb(snap.memoryTotalBytes)} (${percent(
          snap.memoryUsedBytes,
          snap.memoryTotalBytes,
        )})`,
        `⏱️ Uptime: ${fmtUptime(snap.uptimeSec)}`,
        `📊 DB Size: ${mb(snap.dbSizeBytes)}`,
        `📡 Bot: ${
          snap.botLastUpdateAgoSec === null
            ? 'idle'
            : `polling OK (last update ${snap.botLastUpdateAgoSec}s ago)`
        }`,
        `🔌 Sensors: ${snap.sensorsOnline}/${snap.sensorsTotal} online`,
      ];
      return lines.join('\n');
    },
    collectFailed: '❌ Failed to collect system health',
  },
  logs: {
    header(name: string, count: number): string {
      return `📋 Logs for ${name} (last ${count}):`;
    },
    none(name: string): string {
      return `No logs for sensor '${name}'`;
    },
    line(entry: LogLineView): string {
      return `${fmtDate(entry.timestamp, true)} [${entry.level.toUpperCase()}] ${entry.message}`;
    },
    fileName(name: string): string {
      return `logs_${name}_${format(new Date(), 'yyyy-MM-dd')}.txt`;
    },
    notFound: (name: string) => `❌ Sensor '${name}' not found`,
    invalidDuration: '❌ Invalid duration format. Use: 30m, 2h, 1d, 7d',
    invalidCount: '❌ Invalid count. Use a positive number.',
    readFailed: '❌ Failed to read logs',
  },
  help: {
    user: [
      '📖 Available Commands',
      '',
      '/status — sensor status',
      '/logs <sensor> [count] — sensor logs',
      '/mute <sensor> — mute a sensor for yourself',
      '/unmute <sensor> — re-enable a sensor for yourself',
      '/quiet_hours HH:MM-HH:MM | off — silence info notifications',
      '/camera <snapshot|events|video|photo|status> — camera & motion',
      '/ping — check bot response',
      '/help — this message',
    ].join('\n'),
    admin: [
      '📖 Available Commands',
      '',
      '/status — sensor status',
      '/logs <sensor> [count] — sensor logs',
      '/mute <sensor> — mute a sensor for yourself',
      '/unmute <sensor> — re-enable a sensor for yourself',
      '/quiet_hours HH:MM-HH:MM | off — silence info notifications',
      '/camera <snapshot|events|video|photo|status> — camera & motion',
      '/ping — check bot response',
      '/help — this message',
      '',
      '🔧 Admin Commands',
      '',
      '/health — system health',
      '/config add|modify|remove — manage sensors',
      '/export_config — download current config as YAML',
      '/import_config — import sensors from a YAML file',
      '/invite — issue a one-time invite code',
      '/promote <user> — promote a user to admin',
      '/demote <user> — demote an admin to user',
      '/feature enable|disable|list — toggle optional features',
      '/update — pull and install latest version',
      '/rollback — revert to previous version',
      '/system_update — update OS dependencies (apt, rclone, node)',
      '/restart — restart the worker',
      '/camera enable|disable — start/stop motion daemon',
      '/gdrive status — Google Drive sync status',
      '/claim_admin — claim admin (first run only)',
    ].join('\n'),
  },
  config: {
    typeQuestion: 'What type of sensor?',
    nameQuestion: 'Sensor name?',
    pinQuestion: 'GPIO pin number?',
    activeQuestion: 'Active high or low?',
    pullQuestion: 'Pull resistor?',
    severityQuestion: 'Severity level?',
    portQuestion: 'Serial port path?',
    baudQuestion: 'Baud rate?',
    warningQuestion: 'Warning threshold (ppm)?',
    criticalQuestion: 'Critical threshold (ppm)?',
    removeConfirm: (name: string) =>
      `Remove sensor "${name}"? This will archive it.`,
    removed: (name: string) => `✅ Sensor "${name}" archived.`,
    cancelled: 'Cancelled.',
    addedDigital: (
      name: string,
      pin: number,
      activeLow: boolean,
      pull: 'up' | 'down' | 'none',
      severity: SensorSeverity,
    ) =>
      `✅ Sensor "${name}" added (GPIO ${pin}, active ${
        activeLow ? 'low' : 'high'
      }, pull ${pull}, ${severity})`,
    addedUart: (
      name: string,
      port: string,
      baud: number,
      warning: number,
      critical: number,
    ) =>
      `✅ Sensor "${name}" added (UART ${port}, ${baud} baud, warn: ${warning}, crit: ${critical})`,
    modifyHeader: (sensor: ConfigDisplay) => {
      const lines = [
        `Current config for "${sensor.name}":`,
        `Type: ${prettyType(sensor.type)}`,
      ];
      if (sensor.type === 'digital') {
        lines.push(
          `GPIO: ${(sensor.config.pin as number | undefined) ?? '?'}`,
          `Active Low: ${sensor.config.activeLow === false ? 'No' : 'Yes'}`,
          `Pull: ${prettyPull(sensor.config.pull as string | undefined)}`,
        );
      } else if (sensor.type === 'uart') {
        lines.push(
          `Port: ${(sensor.config.port as string | undefined) ?? '?'}`,
          `Baud: ${(sensor.config.baudRate as number | undefined) ?? '?'}`,
          `Warn: ${(sensor.config.thresholds as { warning?: number } | undefined)?.warning ?? '?'} ppm`,
          `Crit: ${(sensor.config.thresholds as { critical?: number } | undefined)?.critical ?? '?'} ppm`,
        );
      }
      lines.push(
        `Debounce: ${sensor.debounceMs}ms`,
        `Severity: ${sensor.severity}`,
        '',
        'What to change?',
      );
      return lines.join('\n');
    },
    modifyMenuPrompt: 'What to change?',
    modifiedField: (field: string) => `✅ ${field} updated. Anything else?`,
    modifyDone: (name: string) => `✅ Sensor "${name}" updated.`,
    nameTaken: (name: string) => `❌ Sensor '${name}' already exists`,
    notFound: (name: string) => `❌ Sensor '${name}' not found`,
    pinTaken: (pin: number, owner: string) =>
      `❌ GPIO ${pin} already used by '${owner}'`,
    invalidPin: '❌ GPIO pin must be 0-27',
    invalidName:
      '❌ Invalid sensor name. Use alphanumerics and underscores only.',
    invalidNumber: '❌ Please enter a valid number.',
    invalidPort: '❌ Serial port path must be a non-empty string.',
    thresholdsOrder: '❌ Warning threshold must be less than critical.',
    missingArg: (cmd: string) => `❌ Usage: /config ${cmd} <sensor_name>`,
    addStarted: 'Starting /config add — reply with answers below.',
  },
  mute: {
    missingSensor: '❌ Usage: /mute <sensor_name>',
    missingSensorUnmute: '❌ Usage: /unmute <sensor_name>',
    notFound: (name: string) => `❌ Sensor '${name}' not found`,
    muted: (name: string) => `🔇 Notifications muted for ${name}.`,
    alreadyMuted: (name: string) => `ℹ️ ${name} is already muted`,
    unmuted: (name: string) => `🔔 Notifications enabled for ${name}.`,
    notMuted: (name: string) => `ℹ️ ${name} is not muted`,
    muteFailed: '❌ Failed to mute sensor',
    unmuteFailed: '❌ Failed to unmute sensor',
  },
  quietHours: {
    invalidFormat:
      '❌ Use format: /quiet_hours HH:MM-HH:MM (e.g., 23:00-07:00)',
    invalidTime: '❌ Invalid time. Use 24-hour format (00:00-23:59)',
    set: (start: string, end: string) =>
      `🌙 Quiet hours set: ${start} — ${end}\nInfo notifications suppressed. Critical alerts still delivered.`,
    disabled: '☀️ Quiet hours disabled.',
    setFailed: '❌ Failed to set quiet hours',
  },
  ota: {
    checking: '🔄 Checking for updates...',
    upToDate: 'ℹ️ Already up to date.',
    updating: (commit: string) =>
      `🔄 Updating to ${commit}... I will go offline briefly and report back when ready.`,
    inProgress: '⏳ Update already in progress, please wait.',
    fetchFailed: (reason: string) => `❌ Failed to check for updates: ${reason}`,
    updateSuccess: (commit: string) =>
      `✅ Update complete.\nCommit: ${commit}`,
    updateFailed: '❌ Update failed, rolled back to previous version.',
    rollbackStarting: '⏪ Rolling back to previous version...',
    rollbackNoTag: '❌ No previous version to roll back to.',
    rollbackSuccess: (commit: string) => `✅ Rolled back to commit ${commit}.`,
    rollbackFailed: (reason: string) =>
      `❌ Rollback failed: ${reason}. SSH access may be needed.`,
    restarting: '🔄 Restarting...',
    restartComplete: '✅ Restart complete. Uptime reset.',
    restartFailed: (reason: string) => `❌ Restart failed: ${reason}`,
  },

  systemUpdate: {
    checking: '🔄 Checking system dependencies...',
    allUpToDate: '✅ All system dependencies are up to date.',
    header: '🔄 System update available:',
    depLine: (d: DepUpdate): string => {
      switch (d.kind) {
        case 'upgrade':
          return `• ${d.name}: ${d.current} → ${d.available}`;
        case 'node-minor':
          return `• ${d.name}: ${d.current} → ${d.available} (minor)`;
        case 'node-major':
          return `• ${d.name}: ${d.current} → ${d.available} (major — manual)`;
        case 'not-installed':
          return `• ${d.name}: not installed`;
        case 'unknown':
          return `• ${d.name}: version unknown`;
        case 'none':
        default:
          return `• ${d.name}: no update`;
      }
    },
    nodeMajorWarning: (current: string, desired: string) =>
      `⚠️ Node.js major version change detected (${current} → ${desired}). This requires manual intervention.`,
    applyButton: 'Apply',
    cancelButton: 'Cancel',
    applying:
      '🔄 Applying system update... I will run a health check and report back when ready.',
    cancelled: 'System update cancelled.',
    checkFailed: (reason: string) =>
      `❌ Failed to check for updates: ${reason}`,
  },

  camera: {
    usage:
      'Usage: /camera <snapshot|events [DD.MM.YYYY]|video <id>|photo <id>|enable|disable|status>',
    snapshotCaption: (name: string, at: Date) => `📸 ${name} | ${fmtDate(at)}`,
    eventsHeader: (day: Date) => `📹 Motion events for ${format(day, 'dd.MM.yyyy')}:`,
    eventLine: (e: MotionEventView): string => {
      const time = e.startedAt ? format(e.startedAt, 'HH:mm:ss') : '--:--:--';
      const dur = e.durationSec !== null ? ` (${e.durationSec}s)` : '';
      const snap = e.hasSnapshot ? ' 📷' : '';
      return `#${e.id} — ${time}${dur}${snap}`;
    },
    eventsFooter: (count: number) =>
      `${count} event${count === 1 ? '' : 's'}. Use /camera video <id> or /camera photo <id>`,
    eventsNone: (day: Date) => `No motion events on ${format(day, 'dd.MM.yyyy')}`,
    videoCaption: (id: number, at: Date | null, cam: string) =>
      `📹 Event #${id} | ${fmtDate(at, true)} | ${cam}`,
    photoCaption: (id: number, at: Date | null, cam: string) =>
      `📸 Event #${id} | ${fmtDate(at, true)} | ${cam}`,
    driveLinkFallback: (id: number, url: string | null) =>
      url
        ? `📹 Event #${id} is too large for Telegram.\nGoogle Drive: ${url}`
        : `📹 Event #${id} is too large for Telegram and has no Drive link yet.`,
    statusHeader: '📹 Camera Status',
    statusBody: (v: CameraStatusView): string =>
      [
        `Motion: ${v.running ? '✅ Running' : '❌ Stopped'}`,
        `Last event: ${fmtDate(v.lastEventAt)}`,
        `Local storage: ${mb(v.localStorageBytes)}`,
        `Events today: ${v.eventsToday}`,
      ].join('\n'),
    motionStarted: '✅ Motion daemon started.',
    motionStopped: '✅ Motion daemon stopped.',
    alreadyRunning: 'ℹ️ Motion daemon is already running.',
    cameraNotFound: (name: string) => `❌ Camera '${name}' not found.`,
    noCameras: '❌ No cameras configured.',
    motionNotRunning: '❌ Motion daemon is not running. Admin: /camera enable',
    snapshotFailed: '❌ Failed to capture snapshot.',
    invalidDate: '❌ Invalid date. Use format: DD.MM.YYYY',
    eventNotFound: (id: number) => `❌ Event #${id} not found.`,
    videoUnavailable: '❌ Video file is no longer available.',
    noSnapshotForEvent: (id: number) => `❌ No snapshot available for event #${id}.`,
    snapshotFileGone: '❌ Snapshot file is no longer available.',
    startFailed: (reason: string) => `❌ Failed to start motion daemon: ${reason}`,
    stopFailed: (reason: string) => `❌ Failed to stop motion daemon: ${reason}`,
    notInstalled: '❌ Motion is not installed. Re-run install with the camera feature.',
    adminAlert: {
      daemonDown:
        '🚨 Motion daemon is down and could not be restarted automatically. Camera recording is offline.',
      daemonRecovered: '✅ Motion daemon recovered. Camera recording is back online.',
      gdriveSyncFailing: (error: string) =>
        `⚠️ Google Drive sync failing: ${error}`,
      diskWarning:
        '⚠️ Disk usage is high and approaching the critical threshold. Uploaded media will be cleaned up automatically if it keeps climbing.',
      emergencyDiskCleanup:
        '🚨 Emergency disk cleanup ran: old events/logs were pruned and the motion daemon was stopped to free space.',
    },
  },

  gdrive: {
    usage: 'Usage: /gdrive status',
    header: '☁️ Google Drive Status',
    body: (v: GdriveStatusView): string => {
      const lines = [
        `📦 Used: ${gb(v.usedBytes)} / ${gb(v.totalBytes)} (${percent(v.usedBytes, v.totalBytes)})`,
        `📤 Last upload: ${fmtDate(v.lastUploadAt)}`,
        `📋 Pending uploads: ${v.pendingUploads} file${v.pendingUploads === 1 ? '' : 's'}`,
        v.failedUploads > 0 && v.lastError
          ? `⚠️ Failed uploads: ${v.failedUploads} (last error: ${v.lastError})`
          : `⚠️ Failed uploads: ${v.failedUploads}`,
        `🗑️ Auto-cleanup: active (min age: ${v.cleanupMinAgeDays} days)`,
      ];
      if (v.failedUploads >= 5) {
        lines.push(`🚨 Sync unhealthy — ${v.failedUploads} consecutive failures`);
      }
      return lines.join('\n');
    },
    notInstalled: '❌ rclone is not installed.',
    notConfigured: '❌ Google Drive is not configured. Run rclone config.',
    statusFailed: (reason: string) => `❌ Failed to check Drive status: ${reason}`,
  },

  exportConfig: {
    caption: '📄 Current configuration. Edit and send back via /import_config.',
    failed: '❌ Failed to export config.',
  },

  importConfig: {
    prompt: 'Send me a YAML config file.',
    invalidFormat: '❌ Invalid file format. Send a .yml file.',
    tooLarge: '❌ File is too large. Send a config file under 1 MB.',
    parseError: (details: string) => `❌ YAML parse error: ${details}`,
    validationFailed: (errors: string[]): string =>
      [
        '❌ Config validation failed:',
        '',
        ...errors.map((e) => `• ${e}`),
        '',
        'Fix and re-upload.',
      ].join('\n'),
    noChanges: 'ℹ️ Config matches the current setup. No changes to apply.',
    summary: (s: ImportSummary): string => {
      const lines = ['📋 Import summary:', ''];
      lines.push(
        s.added.length > 0 ? `➕ Add: ${s.added.join(', ')}` : '➕ Add: none',
      );
      lines.push(
        s.updated.length > 0
          ? `🔄 Update: ${s.updated.map((u) => `${u.name} (${u.detail})`).join(', ')}`
          : '🔄 Update: none',
      );
      lines.push(
        s.archived.length > 0
          ? `🗄️ Archive: ${s.archived.join(', ')}`
          : '🗄️ Archive: none',
      );
      lines.push('', 'Apply changes?');
      return lines.join('\n');
    },
    applyButton: 'Apply',
    cancelButton: 'Cancel',
    applied: (s: ImportSummary): string =>
      `✅ Config imported. ${s.added.length} added, ${s.updated.length} updated, ${s.archived.length} archived.`,
    cancelled: 'Import cancelled. No changes made.',
    failed: (reason: string) =>
      `❌ Import failed: ${reason}. No changes were made.`,
  },

  system: {
    online: (v: SystemOnlineView): string => {
      const lines = ['🟢 System online', `🔌 Sensors: ${v.sensorsOnline}/${v.sensorsTotal} online`];
      if (v.dbRecovery === 'restored_from_backup') {
        lines.push('⚠️ Database was restored from local backup after corruption.');
      } else if (v.dbRecovery === 'recreated_empty') {
        lines.push('⚠️ Database was recreated empty after corruption — re-import config.');
      }
      if (!v.clockSynchronized) {
        lines.push('⚠️ System clock is not synchronized — early timestamps may drift.');
      }
      lines.push(fmtDate(v.now));
      return lines.join('\n');
    },
    goingOffline: '🔴 System going offline.',
  },
};

function prettyType(type: SensorType): string {
  switch (type) {
    case 'digital':
      return 'Digital';
    case 'uart':
      return 'UART';
    case 'mqtt':
      return 'MQTT';
    case 'camera':
      return 'Camera';
  }
}

function prettyPull(pull: string | undefined): string {
  switch (pull) {
    case 'up':
      return 'Up';
    case 'down':
      return 'Down';
    case 'none':
      return 'None';
    default:
      return 'Up';
  }
}

export interface ConfigDisplay {
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  debounceMs: number;
  severity: SensorSeverity;
}
