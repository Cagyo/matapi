import { format } from 'date-fns';
import type { DbRecovery } from '../database/integrity';
import type { SensorSeverity, SensorType } from '../sensors/domain/sensor';
import type { ImportSummary } from '../sensors/application/import-sensors.use-case';
import type { DepUpdate } from '../system/domain/ports/system-deps.port';
import type { User } from '../telegram/domain/user.entity';
import type { RtspSourcePolicyRelationship } from '../camera/domain/ports/live-source-policy-evaluator.port';
import type { RtspSourceOperationalState } from '../camera/application/get-rtsp-source-overview.use-case';
import type {
  CameraSourceFailureKind,
  CameraSourceRecoveryAction,
} from '../telegram/interfaces/camera-source-error.presenter';
import type {
  ArchiveDrainState,
  ArchiveRequiredAction,
} from '../archive/application/use-cases/report-drive-status.use-case';
import type { RetryDriveArchiveResult } from '../archive/application/use-cases/retry-drive-archive.use-case';
import { deepFreeze } from './freeze';

const DRIVE_DRAIN_LABELS: Record<ArchiveDrainState, string> = {
  active: 'active transfer',
  idle: 'idle',
  'cooling-down': 'provider cooldown',
  'branch-blocked': 'date-folder branch blocked',
  'quota-blocked': 'Drive space blocked',
  'capacity-blocked': 'Drive capacity blocked',
  'policy-blocked': 'Drive policy blocked',
  'clock-blocked': 'system clock blocked',
  'reauthorization-required': 'reauthorization required',
};

const DRIVE_REQUIRED_ACTIONS: Record<NonNullable<ArchiveRequiredAction>, string> = {
  'restore-date-folder': 'Restore the affected date folder, then retry.',
  'free-drive-space': 'Free Drive space; recovery will probe automatically.',
  'fix-capacity-then-retry': 'Resolve the Drive capacity limit, then retry.',
  'fix-policy-then-retry': 'Resolve the Drive policy block, then retry.',
  'fix-system-clock': 'Fix the system clock before archive work resumes.',
  reauthorize: 'Reconnect Google Drive with /gdrive connect.',
};

const DRIVE_RETRY_RESULTS: Record<RetryDriveArchiveResult, string> = {
  scheduled: '✅ Drive archive recovery has been scheduled.',
  stale: '↻ Drive status changed. Refresh status and try again.',
  'automatic-quota-probe': 'ℹ️ Drive space recovery will be probed automatically.',
  reauthorize: 'ℹ️ Reconnect Google Drive with /gdrive connect.',
  'nothing-blocked': 'ℹ️ Nothing is currently blocked.',
};

const presentation = {
  date: {
    format: 'dd.MM.yyyy HH:mm',
    formatWithSeconds: 'dd.MM.yyyy HH:mm:ss',
    timeFormat: 'HH:mm',
    eventDayFormat: 'dd.MM.yyyy',
    eventTimeFormat: 'HH:mm:ss',
    eventUnavailableTime: '--:--:--',
    never: 'never',
    unavailableTime: '—',
    age: {
      underMinute: ' (<1m ago)',
      minutes: (minutes: number) => ` (${minutes}m ago)`,
      hours: (hours: number) => ` (${hours}h ago)`,
      days: (days: number) => ` (${days}d ago)`,
    },
  },
  fallback: {
    unavailable: 'N/A',
    unknown: 'unknown',
    digitalOpen: 'OPEN',
    digitalOpened: 'OPENED',
    digitalClosed: 'CLOSED',
  },
  config: {
    sensorTypes: {
      digital: 'Digital',
      uart: 'UART',
      mqtt: 'MQTT',
      camera: 'Camera',
    },
    severities: {
      info: 'Info',
      warning: 'Warning',
      critical: 'Critical',
    },
    pulls: {
      up: 'Up',
      down: 'Down',
      none: 'None',
      default: 'Up',
    },
  },
  units: {
    gigabytes: 'GB',
    megabytes: 'MB',
    ppm: 'ppm',
    uptime: (days: number, hours: number, minutes: number) => `${days}d ${hours}h ${minutes}m`,
    durationSeconds: (seconds: number) => `${seconds}s`,
    eventDurationSeconds: (seconds: number) => ` (${seconds}s)`,
  },
};

function fmtDate(date: Date | null | undefined, withSeconds = false): string {
  if (!date) return presentation.date.never;
  return format(date, withSeconds ? presentation.date.formatWithSeconds : presentation.date.format);
}

function fmtTime(date: Date | null | undefined): string {
  if (!date) return presentation.date.unavailableTime;
  return format(date, presentation.date.timeFormat);
}

function truncateCamera(camera: string): string {
  return camera.length <= 16 ? camera : `${camera.slice(0, 15)}…`;
}

function fmtAgo(date: Date | null | undefined): string {
  if (!date) return '';
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 0) return '';
  if (diffSec < 60) return presentation.date.age.underMinute;
  if (diffSec < 3600) return presentation.date.age.minutes(Math.floor(diffSec / 60));
  if (diffSec < 86400) return presentation.date.age.hours(Math.floor(diffSec / 3600));
  return presentation.date.age.days(Math.floor(diffSec / 86400));
}

export const TYPE_ICONS: Record<SensorType, string> = {
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
  stepType?: string;
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

export interface BrowseEventLineView {
  id: number;
  startedAt: Date | null;
  camera: string;
  duration: string;
  media: string;
}

export interface BrowseEventButtonView {
  id: number;
  startedAt: Date | null;
  camera: string;
  duration: string;
}

export type BrowseEventActionView = BrowseEventLineView;

export interface BrowseEventMediaView {
  hasLocalVideo: boolean;
  hasDriveVideo: boolean;
  hasPhoto: boolean;
}

export interface CameraStatusView {
  running: boolean;
  lastEventAt: Date | null;
  localStorageBytes: number | null;
  eventsToday: number;
}

export interface GdriveStatusView {
  connection: { generationId: string; state: string; errorCode: string | null } | null;
  account: { permissionId: string; email: string | null; displayName: string | null } | null;
  folders: { root: string; motion: string; backups: string } | null;
  last: { refreshAtMs: number | null; uploadAtMs: number | null; backupAtMs: number | null; reconcileAtMs: number | null; cleanupAtMs: number | null; motionTraversalAtMs: number | null; artifactRegistrationAtMs: number | null };
  artifacts: Record<string, number>;
  attempts: Record<string, number>;
  generations: readonly { generationId: string; state: string; retiredAtMs: number | null }[];
  quota: { limitBytes: number | null; usageBytes: number; usageInDriveBytes: number; usageInDriveTrashBytes: number } | null;
  reclamation: { windowStartedMs: number | null; reclaimedBytes: number } | null;
  requiredAction: ArchiveRequiredAction;
  queue: { queuedVideos: number; retryableVideos: number; oldestQueuedVideoAgeMs: number | null; unhealthyDateFolders: number };
  drainState: ArchiveDrainState;
}

export interface SystemOnlineView {
  sensorsOnline: number;
  sensorsTotal: number;
  dbRecovery: DbRecovery;
  clockSynchronized: boolean;
  archiveRecovered: boolean;
  now: Date;
}

export function gb(bytes: number | null): string {
  if (bytes === null) return presentation.fallback.unavailable;
  return `${(bytes / 1024 ** 3).toFixed(1)} ${presentation.units.gigabytes}`;
}

function mb(bytes: number | null): string {
  if (bytes === null) return presentation.fallback.unavailable;
  return `${Math.round(bytes / 1024 ** 2)} ${presentation.units.megabytes}`;
}

function percent(used: number | null, total: number | null): string {
  if (used === null || total === null || total <= 0) return presentation.fallback.unavailable;
  return `${Math.round((used / total) * 100)}%`;
}

function fmtUptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  return presentation.units.uptime(days, hours, minutes);
}

function fmtDigital(value: string | null, stepType?: string, online = true): string {
  if (!online || value === null) return presentation.fallback.unknown;
  const steps = (en.sensors?.steps as Record<string, Record<string, string>>)?.[stepType ?? 'contact'];
  if (steps) {
    if (value === 'true' || value === '1') return steps.true ?? presentation.fallback.digitalOpened;
    if (value === 'false' || value === '0') return steps.false ?? presentation.fallback.digitalClosed;
  }
  if (value === 'true' || value === '1') return presentation.fallback.digitalOpen;
  if (value === 'false' || value === '0') return presentation.fallback.digitalClosed;
  return value.toUpperCase();
}

function fmtUart(value: string | null, level?: StatusRow['thresholdLevel']): string {
  if (value === null) return presentation.fallback.unknown;
  const marker =
    level === 'critical' ? ' ❌' : level === 'warning' ? ' ⚠️' : level ? ' ✅' : '';
  return `${value} ${presentation.units.ppm}${marker}`;
}

function fmtRowValue(row: StatusRow): string {
  switch (row.type) {
    case 'digital':
      return fmtDigital(row.lastValue, row.stepType, row.online);
    case 'uart':
      return fmtUart(row.lastValue, row.thresholdLevel);
    default:
      return row.lastValue ?? presentation.fallback.unknown;
  }
}

export interface CommandDescriptor {
  command: string;
  description: string;
  usage: string;
  scope: 'user' | 'admin';
}

export const commands: CommandDescriptor[] = [
  {
    command: 'menu',
    description: 'Interactive command dashboard',
    usage: '/menu — interactive command dashboard',
    scope: 'user',
  },
  {
    command: 'status',
    description: 'Sensor status',
    usage: '/status — sensor status',
    scope: 'user',
  },
  {
    command: 'logs',
    description: 'Sensor logs',
    usage: '/logs <sensor> [count] — sensor logs',
    scope: 'user',
  },
  {
    command: 'csv',
    description: 'Export sensor history as CSV',
    usage: '/csv <sensor> [count] — export sensor history as CSV',
    scope: 'user',
  },
  {
    command: 'mute',
    description: 'Mute a sensor for yourself',
    usage: '/mute <sensor> — mute a sensor for yourself',
    scope: 'user',
  },
  {
    command: 'unmute',
    description: 'Re-enable a sensor for yourself',
    usage: '/unmute <sensor> — re-enable a sensor for yourself',
    scope: 'user',
  },
  {
    command: 'quiet_hours',
    description: 'Silence info notifications',
    usage: '/quiet_hours HH:MM-HH:MM | off — silence info notifications',
    scope: 'user',
  },
  {
    command: 'camera',
    description: 'Camera & motion',
    usage: '/camera <snapshot|events|video|photo|status|live|stop_stream> — camera & motion',
    scope: 'user',
  },
  {
    command: 'ping',
    description: 'Check bot response',
    usage: '/ping — check bot response',
    scope: 'user',
  },
  {
    command: 'help',
    description: 'Available commands & help',
    usage: '/help — this message',
    scope: 'user',
  },
  {
    command: 'health',
    description: 'System health',
    usage: '/health — system health',
    scope: 'admin',
  },
  {
    command: 'config',
    description: 'Manage sensors',
    usage: '/config add|modify|remove — manage sensors',
    scope: 'admin',
  },
  {
    command: 'cancel',
    description: 'Cancel an active configuration wizard',
    usage: '/cancel — cancel an active configuration wizard',
    scope: 'admin',
  },
  {
    command: 'export_config',
    description: 'Download current config as YAML',
    usage: '/export_config — download current config as YAML',
    scope: 'admin',
  },
  {
    command: 'import_config',
    description: 'Import sensors from a YAML file',
    usage: '/import_config — import sensors from a YAML file',
    scope: 'admin',
  },
  {
    command: 'invite',
    description: 'Issue a one-time invite code',
    usage: '/invite — issue a one-time invite code',
    scope: 'admin',
  },
  {
    command: 'promote',
    description: 'Promote a user to admin',
    usage: '/promote <user> — promote a user to admin',
    scope: 'admin',
  },
  {
    command: 'demote',
    description: 'Demote an admin to user',
    usage: '/demote <user> — demote an admin to user',
    scope: 'admin',
  },
  {
    command: 'feature',
    description: 'Toggle optional features',
    usage: '/feature list|install|enable|disable <name> — manage optional features',
    scope: 'admin',
  },
  {
    command: 'update',
    description: 'Pull and install latest version',
    usage: '/update — pull and install latest version',
    scope: 'admin',
  },
  {
    command: 'rollback',
    description: 'Revert to previous version',
    usage: '/rollback — revert to previous version',
    scope: 'admin',
  },
  {
    command: 'system_update',
    description: 'Update OS dependencies',
    usage: '/system_update — update allowlisted OS packages (Node upgrades are manual)',
    scope: 'admin',
  },
  {
    command: 'restart',
    description: 'Restart the worker',
    usage: '/restart — restart the worker',
    scope: 'admin',
  },
  {
    command: 'gdrive',
    description: 'Connect, inspect, retry, or disconnect Google Drive',
    usage: '/gdrive connect|status|retry|disconnect — manage Google Drive',
    scope: 'admin',
  },
  {
    command: 'settings',
    description: 'System runtime settings & auto-clean threshold',
    usage: '/settings — system runtime settings',
    scope: 'admin',
  },
  {
    command: 'clean',
    description: 'Manually trigger storage cleanup',
    usage: '/clean [threshold] — manually trigger storage cleanup',
    scope: 'admin',
  },
  {
    command: 'claim_admin',
    description: 'Claim admin (first run only)',
    usage: '/claim_admin <token> — claim admin (first run only)',
    scope: 'admin',
  },
];

const PINOUT_SCHEMA = `<pre>📌 Raspberry Pi GPIO Pinout (BCM)
[xx] = Physical Pin | BCM = GPIO #

       3.3V [01] [02] 5V
      SDA 2 [03] [04] 5V
      SCL 3 [05] [06] GND
          4 [07] [08] 14 TXD
        GND [09] [10] 15 RXD
         17 [11] [12] 18
         27 [13] [14] GND
         22 [15] [16] 23
       3.3V [17] [18] 24
    MOSI 10 [19] [20] GND
     MISO 9 [21] [22] 25
    SCLK 11 [23] [24] 8 CE0
        GND [25] [26] 7 CE1
    ID_SD 0 [27] [28] 1 ID_SC
          5 [29] [30] GND
          6 [31] [32] 12 PWM0
    PWM1 13 [33] [34] GND
    MISO 19 [35] [36] 16
         26 [37] [38] 20 MOSI
        GND [39] [40] 21 SCLK</pre>`;

const enCatalog = {
  presentation,
  commands,
  sensors: {
    steps: {
      contact:     { false: 'Closed',   true: 'Opened',        offline: '❓ Offline' },
      leak_hazard: { false: 'Dry',      true: 'Leak Detected', offline: '❓ Offline' },
      alarm:       { false: 'Normal',   true: 'Alarm',         offline: '❓ Offline' },
      power:       { false: 'Grid OK',  true: 'Outage',        offline: '❓ Offline' },
      motion:      { false: 'Clear',    true: 'Motion',        offline: '❓ Offline' },
      button:      { false: 'Released', true: 'Pressed',       offline: '❓ Offline' },
    },
    notifications: {
      alarmTriggered: (name: string, state: string) => `🚨 *CRITICAL ALARM:* ${name} is now *${state}*!`,
      alarmResolved:  (name: string, state: string) => `✅ *RESOLVED:* ${name} is back to *${state}*.`,
      infoChange:     (name: string, state: string, oldState: string) => `ℹ️ *${name}:* ${state} (was ${oldState})`,
      flappingFault:  (name: string) => `⚠️ *FAULT:* Sensor *${name}* switched to polled sampling due to flapping!`,
      viewLogs: '📋 View Logs',
      watchLive: '📺 Watch live',
      mqttOffline: '🔴 MQTT broker offline',
      mqttRecovered: '🟢 MQTT broker reconnected',
    },
  },
  common: {
    adminRequired: '❌ Admin access required',
    error: (action: string, reason: string) => `❌ Failed to ${action}: ${reason}`,
    failure: (reason: string) => `❌ Failed: ${reason}`,
    historical: (value: string) => `Historical value: ${value}`,
    interrupted: 'Previous operation was interrupted. Please start again.',
    cancelButton: '❌ Cancel',
    backButton: '« Back',
    closeButton: '❌ Close',
    quietModeButton: '🌙 Quiet Mode',
    noActiveWizard: 'ℹ️ No active configuration wizard to cancel.',
  },
  language: {
    prompt: 'Choose your language:',
    current: (language: string) => `Current language: ${language}`,
    updated: (language: string) => `✅ Language changed to ${language}.`,
    updateFailed: 'Could not change the language. Try again.',
    retryLanguageChange: 'Retry language change',
    returnToMore: '« More',
    restoreMoreFailed: 'Language changed, but More could not be restored.',
    buttons: {
      en: 'English',
      ru: 'Русский',
      uk: 'Українська',
    },
  },
  claim: {
    success: '✅ You are now the admin of this Home Worker.',
    alreadyClaimed: '❌ This Home Worker already has an admin.',
    invalidToken: '❌ Invalid setup claim token. Use the command shown by the setup wizard.',
    notConfigured: '❌ Admin claiming is disabled until CLAIM_ADMIN_TOKEN is configured.',
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
    finalAdmin: '❌ Cannot demote the final admin.',
    promoteFailed: '❌ Failed to promote user',
    demoteFailed: '❌ Failed to demote user',
    registerFailed: '❌ Failed to register',
    missingTarget: (cmd: string) =>
      `❌ Usage: /${cmd} <name|id:telegram_id>`,
    ambiguousTarget: (
      cmd: string,
      matches: readonly Pick<User, 'telegramId' | 'name'>[],
    ) =>
      `❌ Multiple users match. Retry /${cmd} with id:<telegram_id>: ${matches
        .map((match) => `${match.name} (id:${match.telegramId})`)
        .join(', ')}`,
  },
  home: {
    title: '🏠 Home',
    verdicts: {
      attention: (count: number) => `⚠️ ${count} sensor${count === 1 ? '' : 's'} need attention`,
      unavailable: '⚠️ Monitoring is unavailable',
      normal: '✅ Everything looks normal',
    },
    state: {
      counts: (known: number, unknown: number) => `States: ${known} known · ${unknown} unknown`,
      absent: 'States: no sensor readings yet',
    },
    health: {
      counts: (online: number, total: number) => `Sensors reporting: ${online} of ${total}`,
      absent: 'Monitoring: no completed check yet',
      stale: 'Monitoring: last check is stale',
      checking: '⏳ Checking monitoring…',
      failed: 'Monitoring: the last check failed',
    },
    buttons: {
      sensors: '📊 Sensors',
      camera: '📷 Camera',
      notifications: '🔔 Notifications',
      more: '⋯ More',
      checkNow: '↻ Check now',
    },
    notifications: {
      normal: 'Notifications: normal',
      quietHours: (until: string) => `Notifications: quiet until ${until}`,
      timedPause: (until: Date) => `Notifications: paused until ${fmtTime(until)}`,
      legacyPause: 'Notifications: legacy pause is active',
      pausedTargets: (count: number) => `Notifications: ${count} target${count === 1 ? '' : 's'} paused`,
      title: '🔔 Notifications',
      quietHoursSummary: (start: string | null, end: string | null) => start && end ? `Quiet hours: ${start}–${end}` : 'Quiet hours: off',
      legacyMutedSummary: 'Legacy pause is active',
      mutedTargetsSummary: (count: number) => `${count} target${count === 1 ? '' : 's'} paused`,
      preset22To07: '22:00–07:00',
      preset23To06: '23:00–06:00',
      preset00To08: '00:00–08:00',
      presetOff: 'Quiet hours off',
      targetSettings: '🎯 Target settings',
      pause: '⏸ Pause alerts',
      resume: '▶ Resume alerts',
      undoQuietHours: '↩ Undo quiet hours',
      targetsTitle: '🎯 Notification targets',
      targetsPage: (page: number, pageCount: number, total: number) => `Page ${page} of ${pageCount} · ${total} targets`,
      targetsEmpty: 'No notification targets are available.',
      targetTitle: '🎯 Notification target',
      targetMuted: 'Alerts paused for this target',
      targetActive: 'Alerts active for this target',
      mute: '🔇 Pause alerts',
      unmute: '🔊 Resume alerts',
      pauseTitle: '⏸ Pause alerts',
      pausePrompt: 'Choose how long to pause non-critical alerts:',
      pauseHours: (hours: number) => `${hours} hour${hours === 1 ? '' : 's'}`,
      pauseConfirmation: (hours: number) => `Pause non-critical alerts for ${hours} hour${hours === 1 ? '' : 's'}?`,
      confirmPause: 'Confirm pause',
    },
    sensors: {
      title: '📊 Sensors',
      row: (name: string, state: string) => `• ${name}: ${state}`,
      page: (page: number, pageCount: number, total: number) => `Page ${page} of ${pageCount} · ${total} sensors`,
      clamp: (page: number) => `The list changed; showing page ${page}.`,
      attention: (names: readonly string[]) => `Needs attention: ${names.join(' · ')}`,
      attentionShown: (shown: number, total: number) => `${shown} of ${total} shown`,
      emptyMember: 'No sensors configured. Ask an administrator to add one.',
      emptyAdmin: 'No sensors configured.',
      setupSensors: '⚙️ Set up sensors',
      previous: '‹ Previous',
      next: 'Next ›',
      back: '« Back',
      home: '🏠 Home',
    },
    common: {
      back: '« Back',
      home: '🏠 Home',
    },
    workflow: {
      backTo: (destination: string) => `Back to ${destination}`,
      cancel: (workflow: string) => `Cancel ${workflow}`,
      home: 'Home',
      workContinues: (work: string) => `${work} · work continues`,
      unfinishedSetupExpired: 'Your unfinished setup expired after the restart.',
      retryReturn: 'Retry return',
      returnUnavailable: 'Return is temporarily unavailable.',
      outcomeNotice: (outcome: string) => outcome,
    },
    navigation: {
      backTo: {
        notifications: '« Notifications',
        'notification-targets': '« Notification targets',
        'pause-duration': '« Notifications',
        history: '« More',
        more: '« More',
        'admin-tools': '« Admin tools',
        'admin-storage': '« Storage & backup',
        'admin-system': '« System',
      },
    },
    history: {
      title: '🗂 History',
      logs: '📜 Logs',
      applicationLogs: '🧾 Application logs',
      errors: '❌ Errors',
      exportCsv: '⬇ Export CSV',
    },
    more: {
      title: '⋯ More',
      history: '🗂 History',
      settings: '⚙️ My settings',
      help: '❓ Help',
      adminTools: '🛠 Admin tools',
    },
    adminTools: {
      title: '🛠 Admin tools',
      sensorSetup: '⚙️ Sensor setup',
      storage: '💾 Storage & backup',
      system: '🖥 System',
      invite: '👤 Create invite',
      features: '🔧 Features',
    },
    adminSensorSetup: {
      title: '⚙️ Sensor setup',
      add: '➕ Add',
      modify: '✏️ Edit',
      remove: '🗑 Remove',
      import: '⬆ Import',
      export: '⬇ Export',
    },
    adminStorage: {
      title: '💾 Storage & backup',
      driveStatus: '☁️ Drive status',
      connectDrive: '🔗 Connect Drive',
      cleanup: '🧹 Clean up storage',
    },
    adminSystem: {
      title: '🖥 System',
      health: '❤️ Health',
      packages: '📦 System packages',
      restart: '🔄 Restart worker',
      cleanupThreshold: '🧹 Cleanup threshold',
    },
    adminCleanupThreshold: {
      title: '🧹 Cleanup threshold',
      threshold: (value: number, current: number) => `${value}%${value === current ? ' ✓' : ''}`,
    },
    confirmation: {
      cleanup: 'Clean up storage?',
      restart: 'Restart the worker?',
      confirmCleanup: 'Confirm cleanup',
      confirmRestart: 'Confirm restart',
    },
    cleanupResult: {
      executed: (threshold: number | null) => threshold === null ? 'Cleanup started.' : `Cleanup started at ${threshold}%.`,
      inProgress: 'Cleanup is already in progress.',
      failed: 'Cleanup could not be started.',
    },
    recovery: {
      stale: 'This Home is no longer active.',
      updating: 'This Home is updating. Try again in a moment.',
      unavailable: 'Home is temporarily unavailable. Use a direct command and try again.',
      openNewHome: '🏠 Open new Home',
      retryReturn: 'Retry return',
      closed: 'Home monitoring closed.',
    },
    legacyNotifications: {
      title: '🔔 Notifications',
      muteSensors: '🔇 Mute sensors',
      unmuteSensors: '🔊 Unmute sensors',
      quietHours: '🌙 Quiet hours',
    },
  },
  feature: {
    names: { digital: 'Digital inputs', uart: 'UART CO₂ sensor', zigbee: 'Zigbee', motion: 'Motion camera', rtsp: 'RTSP camera' },
    description: { digital: 'GPIO digital-input support', uart: 'CO₂ UART sensor support', zigbee: 'Zigbee MQTT bridge support', motion: 'Motion camera recording', rtsp: 'RTSP live-stream runtime' },
    stale: { disabled: (name: string) => `${name} is disabled.`, attention: (name: string) => `${name} needs attention.`, installing: (name: string) => `${name} is still installing.`, unavailable: (name: string) => `${name} is unavailable.` },
    state: { 'not-installed': 'not installed', 'installed-off': 'disabled', enabled: 'enabled', 'needs-attention': 'needs attention', installing: 'installing' },
    impact: { dependencies: { gpiod: 'gpiod (GPIO)', uart: 'UART support', mosquitto: 'Mosquitto', motion: 'Motion', 'rtsp-runtime': 'RTSP runtime' }, controls: { 'digital-sensors': 'digital sensors', 'uart-sensors': 'UART sensors', 'mqtt-sensors': 'MQTT sensors', 'motion-camera': 'motion camera', 'live-streams': 'live streams' }, monitoring: { 'sensor-work': 'sensor monitoring', 'camera-work': 'camera monitoring' } },
    attention: { 'inconsistent-state': 'state is inconsistent', 'readiness-failed': 'readiness check failed', 'install-failed': 'installation failed', 'partial-state-uncertain': 'state needs repair', 'restart-required': 'restart required', 'helper-update-required': 'installer update required' },
    usage: '❌ Usage: /feature list|install|enable|disable <name>',
    listHeader: '🔧 Features',
    listButton: (name: string, state: string) => `${name} — ${state}`,
    listBack: '« Features',
    reinstallAction: '🔁 Reinstall on current network',
    reinstallNotice: 'Cameras, sources and saved credentials are kept. Live streams stop until the reinstall finishes.',
    downtime: { worker: 'Worker restarts briefly.', supervisor: 'Service restarts briefly.', host: 'Pi reboot is required.' },
    detail: ({ name, description, state, dependencies, controls, monitoring, downtime, attention }: { name: string; description: string; state: string; dependencies: string; controls: string; monitoring: string; downtime: string; attention: string | null }) => [name, description, `State: ${state}`, `Dependencies: ${dependencies}`, `Controls: ${controls}`, `Monitoring: ${monitoring}`, downtime, attention ? `Attention: ${attention}` : ''].filter(Boolean).join('\n'),
    confirmation: { install: (name: string, scope: string) => `Install ${name} — ${scope}`, reinstall: (name: string, scope: string) => `Reinstall ${name} now — ${scope}`, enable: (name: string, scope: string) => `Enable ${name} — ${scope}`, disable: (name: string, scope: string) => `Disable ${name} — ${scope}`, verify: (name: string, _scope: string) => `Verify ${name}` },
    restartScope: { worker: 'worker restart', supervisor: 'service restart', host: 'Pi reboot' },
    failure: { 'request-invalid': 'invalid install request', 'request-publish-failed': 'request could not be queued', 'local-network-unavailable': 'no eligible local network', 'network-policy-generation-failed': 'network policy could not be prepared', 'dependency-install-failed': 'dependency installation failed', 'privileged-verification-failed': 'privileged verification failed', 'application-verification-failed': 'application verification failed', 'partial-state-uncertain': 'state needs repair', 'helper-version-mismatch': 'installer update required', 'result-invalid': 'invalid installer result', interrupted: 'installation interrupted' },
    preRestart: (name: string, scope: string) => `⏳ ${name} is ready. ${scope} is starting; the final result will follow after recovery.`,
    progress: { installing: (name: string) => `⏳ Installing ${name}. You will receive the outcome when it is ready.`, reinstalling: (name: string) => `⏳ Reinstalling ${name} on the current network. You will receive the outcome when it is ready.` },
    outcome: { success: (name: string) => `✅ ${name} completed.`, failure: (name: string, reason: string) => `❌ ${name} failed (${reason}).`, genericFailure: (name: string) => `❌ ${name} could not be completed.`, recoveredSuccess: (name: string) => `Recovered successful result for ${name}.`, recoveredFailure: (name: string, reason: string) => `Recovered failed result for ${name} (${reason}).` },
    recovery: { stale: 'This feature control is no longer current. Open Features again.', unavailable: 'Feature workflow is temporarily unavailable.' },
    busy: (name: string) => `${name} already has an installation in progress.`,
    errors: { installStart: (name: string) => `❌ ${name} could not be queued.`, notInstalled: (name: string) => `❌ ${name} is not installed.`, inconsistent: (name: string) => `❌ ${name} needs repair before changing it.`, alreadyEnabled: (name: string) => `${name} is already enabled.`, alreadyDisabled: (name: string) => `${name} is already disabled.`, restartFailed: (name: string, scope: string) => `❌ ${name} changed, but ${scope} could not start.`, reinstallUnavailable: (name: string) => `❌ ${name} cannot be reinstalled right now.` },
    verificationFailed: (name: string) => `❌ ${name} did not pass readiness verification.`,
    unknown: (name: string) =>
      `❌ Unknown feature '${name}'. Use /feature list.`,
    listFailed: '❌ Failed to list features',
  },
  setupWizard: {
    featureDescriptions: {
      rtsp: 'Experimental Motion MJPEG live stream',
    },
  },
  status: {
    header: '📊 System Status',
    none: 'No sensors configured. Use /config to add sensors.',
    line(row: StatusRow): string {
      const icon = TYPE_ICONS[row.type] ?? '•';
      let value = fmtRowValue(row);
      if (!row.online) {
        const offlineStep = (en.sensors?.steps as Record<string, Record<string, string>>)?.[row.stepType ?? 'contact']?.offline;
        value = offlineStep ?? '❓ Offline';
      }
      const ago = fmtAgo(row.lastValueAt);
      let suffix = '';
      if (!row.online) {
        suffix = ` ⚠️ offline${ago}`;
      } else if (
        row.type === 'digital' &&
        (row.lastValue === 'true' || row.lastValue === '1') &&
        row.lastValueAt
      ) {
        suffix = ` ⚠️ (since ${fmtTime(row.lastValueAt)}${ago})`;
      } else if (ago) {
        suffix = ago;
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
    application: {
      outputCaption: '📄 Application logs — up to the latest 200 lines.',
      errorCaption: '📄 Application errors — up to the latest 200 lines.',
      outputEmpty: 'No application output is available.',
      errorEmpty: 'No application errors are available.',
      truncated: '⚠️ Older lines were omitted by the 2 MiB safety limit.',
      unavailable: '❌ Application logs are unavailable right now.',
      invalidArguments: '❌ Use /logs app or /logs error without extra arguments.',
    },
    header(name: string, count: number): string {
      return `📋 Logs for ${name} (last ${count}):`;
    },
    none(name: string): string {
      return `No logs for sensor '${name}'`;
    },
    line(entry: LogLineView): string {
      return `${fmtDate(entry.timestamp, true)} [${entry.level.toUpperCase()}] ${entry.message}`;
    },
    stateChange(stepType: string, oldVal: boolean, newVal: boolean): string {
      const steps = (en.sensors?.steps as Record<string, Record<string, string>>)?.[stepType] || en.sensors.steps.contact;
      let oldStr = (oldVal ? steps.true : steps.false).toUpperCase();
      let newStr = (newVal ? steps.true : steps.false).toUpperCase();
      if (stepType === 'contact') {
        if (oldStr === 'OPENED') oldStr = 'OPEN';
        if (newStr === 'OPENED') newStr = 'OPEN';
      }
      return `State changed: ${oldStr} → ${newStr}`;
    },
    debounceTriggered(count: number, windowSec: number): string {
      return `Debounce triggered (${count} events in ${windowSec}s)`;
    },
    flappingFault(name: string, pin: number): string {
      return `Sensor "${name}" (pin ${pin}) flapping! Switching to 10s polled sampling mode.`;
    },
    fileName(name: string): string {
      return `logs_${name}_${format(new Date(), 'yyyy-MM-dd')}.txt`;
    },
    notFound: (name: string) => `❌ Sensor '${name}' not found`,
    invalidDuration: '❌ Invalid duration format. Use: 30m, 2h, 1d, 7d',
    invalidCount: '❌ Invalid count. Use a positive number.',
    selectSensor: '📋 Select a sensor to view recent logs:',
    readFailed: '❌ Failed to read logs',
  },
  csv: {
    selectTarget: '📄 Select a sensor history to export:',
    empty: 'No sensor histories are available to export.',
    invalidCount: '❌ Invalid CSV count. Use a whole number from 1 to 5000.',
    invalidSelection: '❌ That CSV selection is no longer valid. Please choose again.',
    notFound: '❌ The selected sensor history was not found.',
    noRows: 'ℹ️ The selected sensor has no history rows to export.',
    rowTooLarge: '❌ A selected history row is too large to export.',
    fileTooLarge: '❌ The CSV file is too large to export.',
    malformedTimestamp: '❌ A selected history row has an invalid timestamp.',
    staging: '⏳ Your CSV export is being prepared. You can return Home without cancelling it.',
    inProgress: '⏳ A CSV export from this picker is already in progress.',
    failed: '❌ Failed to export CSV.',
    caption: '📄 Sensor history CSV export.',
    previousPage: '‹ Previous',
    nextPage: 'Next ›',
    disabledTarget: (name: string) => `⏸️ ${name} (disabled)`,
    archivedTarget: (name: string) => `🗄️ ${name} (archived)`,
  },
  help: {
    user: [
      '📖 Available Commands',
      '',
      ...commands.filter((c) => c.scope === 'user').map((c) => c.usage),
    ].join('\n'),
    admin: [
      '📖 Available Commands',
      '',
      ...commands.filter((c) => c.scope === 'user').map((c) => c.usage),
      '',
      '🔧 Admin Commands',
      '',
      ...commands.filter((c) => c.scope === 'admin').map((c) => c.usage),
    ].join('\n'),
  },
  menu: {
    title: '🎛️ Interactive Command Dashboard\nSelect a category or command below:',
    closed: 'Dashboard closed.',
    categories: {
      sensors: '📊 Status & Sensors',
      media: '📷 Camera & Media',
      admin: '⚙️ Admin & Config',
      lifecycle: '🔄 Lifecycle & Maintenance',
    },
    buttons: {
      status: '📊 Status',
      health: '🏥 Health',
      logs: '📋 Logs',
      exportCsv: '📄 Export CSV',
      mute: '🔇 Mute',
      cameraStatus: '📷 Camera Status',
      gdrive: '☁️ Drive Sync',
      config: '⚙️ Config',
      settings: '⚙️ Settings',
      clean: '🧹 Trigger Clean',
      invite: '🔗 Invite',
      feature: '🔧 Features',
      update: '⬆️ Update',
      restart: '🔄 Restart',
      exportConfig: '📤 Export Config',
    },
    submenus: {
      configTitle: '⚙️ *Sensor Configuration*\n\nSelect an operation:',
      configAdd: '➕ Add Sensor',
      configModify: '✏️ Modify Sensor',
      configRemove: '🗑️ Remove Sensor',
      featuresTitle: '🔧 *Feature Management*\n\nSelect a feature to toggle or view:',
      featuresList: '📋 List All Features',
      restartConfirmTitle: '⚠️ *Confirm System Restart*\n\nAre you sure you want to restart the worker service?',
      updateConfirmTitle: '⬆️ *Confirm System Update*\n\nCheck for and apply the latest code updates?',
      confirmYes: '⚠️ Yes, Proceed',
      confirmNo: '❌ Cancel',
      sensorsTitle: '📊 *Sensor Operations*\n\nSelect an action:',
      sensorsMute: '🔇 Mute Sensor',
      sensorsUnmute: '🔊 Unmute Sensor',
      sensorsMuteAll: '🔇 Mute All',
      sensorsUnmuteAll: '🔊 Unmute All',
      sensorsExportCsv: '📄 Export CSV',
      systemTitle: '🔄 *System & Maintenance*\n\nSelect an operation:',
      systemUpdate: '⬆️ Check for Updates',
      systemRestart: '🔄 Restart Worker',
      systemHealth: '🏥 System Health',
      systemDrive: '☁️ Drive Sync Status',
      systemSettings: '⚙️ System Settings',
      systemClean: '🧹 Trigger Clean Now',
      systemInvite: '🔗 Create Invite Code',
      backToMenu: '« Back',
      quietTitle: '🌙 *Quiet Mode (Schedule)*\n\nSelect a preset quiet hours schedule:',
      quiet22_07: '🌙 22:00 - 07:00 (10h)',
      quiet23_06: '🌙 23:00 - 06:00 (8h)',
      quiet00_08: '🌙 00:00 - 08:00 (8h)',
      quietDisable: '🔔 Disable Quiet Mode',
    },
    quietMode: {
      title: '🌙 *Quiet Mode*\n\nSelect how long to suppress info notifications:',
      h1: '1 Hour',
      h4: '4 Hours',
      h8: '8 Hours',
      off: '🔔 Unmute All (Normal Mode)',
      activated: (hours: number) => `🌙 *Quiet Mode Activated*\nAll info notifications suppressed for ${hours} hour${hours === 1 ? '' : 's'}. Critical alerts will still be delivered.`,
      deactivated: '🔔 *Quiet Mode Deactivated*\nNormal notifications restored.',
    },
    usage: {
      logs: 'Usage: /logs <sensor> [count] — e.g. /logs front_door 20',
      mute: 'Usage: /mute <sensor> — e.g. /mute front_door',
      config: 'Usage: /config add|modify|remove — manage sensors',
      feature: 'Usage: /feature list|install|enable|disable <name> — manage optional features',
      update: 'To update the worker to the latest version, send /update',
      restart: 'To restart the worker, send /restart',
    },
  },
  config: {
    selectModify: '✏️ *Select Sensor to Modify*\n\nChoose an active sensor to edit its configuration:',
    selectRemove: '🗑️ *Select Sensor to Remove*\n\nChoose an active sensor to delete:',
    noActiveSensors: 'ℹ️ No active sensors configured.',
    cancelSensorSetup: 'Cancel sensor setup',
    step1: 'Step 1 of 5 — What type of sensor?',
    step2: (type: string) => `Step 2 of 5 (${type})\n\nSensor name?`,
    step3Digital: (name: string, usedPins?: string) =>
      `Step 3 of 5 (Digital: "${name}")\n\nChoose an available GPIO pin.\n\n${PINOUT_SCHEMA}${
        usedPins ? `\n\nCurrently used: ${usedPins}` : ''
      }`,
    step4Digital: (name: string, pin: number) => `Step 4 of 5 (Digital: "${name}", Pin ${pin})\n\nSelect Step Type (device class):`,
    step5Digital: (name: string, pin: number, stepType: string) => `Step 5 of 5 (Digital: "${name}", Pin ${pin}, ${stepType})\n\nSeverity level?\n💡 _Hint: Info = silent log; Warning = standard alert; Critical = urgent alarm._`,
    step3Uart: (name: string) => `Step 3 of 5 (UART: "${name}")\n\nSerial port path? (e.g. /dev/serial0)`,
    step4Uart: (name: string, port: string) => `Step 4 of 5 (UART: "${name}", Port ${port})\n\nBaud rate?\n💡 _Hint: Communication speed in bits/sec. 9600 is standard for most CO2 sensors._`,
    step5Uart: (name: string, port: string, baud: number) => `Step 5 of 5 (UART: "${name}", Port ${port}, ${baud} baud)\n\nWarning threshold (ppm)?\n💡 _Hint: CO2 level in ppm that triggers a warning alert (e.g., 1000)._`,
    typeQuestion: 'What type of sensor?',
    nameQuestion: 'Sensor name?',
    pinQuestion: (usedPins?: string) =>
      `GPIO pin number (0–27)?\n\n${PINOUT_SCHEMA}${
        usedPins ? `\n\nCurrently used: ${usedPins}` : ''
      }`,
    gpioPickerOnly: 'Choose one of the available GPIO buttons below.',
    noAvailableGpioPins: '❌ No GPIO pins are available. Remove or reconfigure a digital sensor, then try again.',
    stepTypeQuestion: 'Select Step Type (device class):',
    activeQuestion: 'Active high or low?',
    pullQuestion: 'Pull resistor?',
    severityQuestion: 'Severity level?',
    portQuestion: 'Serial port path?',
    baudQuestion: 'Baud rate?',
    warningQuestion: 'Warning threshold (ppm)?',
    criticalQuestion: 'Critical threshold (ppm)?\n💡 _Hint: Urgent CO2 level (must be higher than warning, e.g., 1500)._',
    debouncePrompt: 'Debounce (ms)?\n💡 _Hint: Time in milliseconds to ignore button chatter or rapid toggling (e.g., 10000 = 10s)._',
    defaultButton: '⚡ Use Defaults (Contact, Info)',
    invertToggleSuccess: (name: string, newState: string) => `✅ Inverted logical state for sensor "${name}". Current state is now: ${newState}`,
    removeConfirm: (name: string) =>
      `Remove sensor "${name}"? This will archive it.`,
    removed: (name: string) => `✅ Sensor "${name}" archived.`,
    cancelled: 'Cancelled.',
    addedDigital: (
      name: string,
      pin: number,
      stepType: string,
      severity: SensorSeverity,
    ) =>
      `✅ Sensor "${name}" added (GPIO ${pin}, ${stepType}, ${severity})`,
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
        `Type: ${presentation.config.sensorTypes[sensor.type]}`,
      ];
      if (sensor.type === 'digital') {
        const inv = sensor.config.invert ?? sensor.config.activeLow ?? true;
        const pull = sensor.config.pull as string | undefined;
        lines.push(
          `GPIO: ${(sensor.config.pin as number | undefined) ?? '?'}`,
          `Step Type: ${(sensor.config.stepType as string | undefined) ?? 'contact'}`,
          `Active Low: ${inv === false ? 'No' : 'Yes'} — triggered when the signal is ${inv === false ? 'high' : 'low'}`,
          `Pull: ${presentation.config.pulls[pull as keyof typeof presentation.config.pulls] ?? presentation.config.pulls.default} — ${pull === 'none' ? 'no internal resistor; use external wiring to keep the input stable' : 'keeps the input stable when unconnected'}`,
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
        `Debounce: ${sensor.debounceMs}ms — ignores repeat signals briefly`,
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
    invalidPinRange: '❌ Invalid GPIO pin number. Please enter a valid number between 0 and 27:',
    invalidThresholdOrder: (warn: number) =>
      `❌ Critical threshold must be greater than warning threshold (${warn} ppm). Please enter a critical threshold > ${warn}:`,
    invalidPortPath:
      '❌ Serial port path must be a non-empty string (e.g. /dev/ttyUSB0):',
    invalidDebounce:
      '❌ Please enter debounce time in milliseconds (0 or greater):',
    invalidPort: '❌ Serial port path must be a non-empty string.',
    thresholdsOrder: '❌ Warning threshold must be less than critical.',
    missingArg: (cmd: string) => `❌ Usage: /config ${cmd} <sensor_name>`,
    addStarted: 'Starting /config add — reply with answers below.',
  },
  mute: {
    missingSensor: '❌ Usage: /mute <sensor_name>',
    missingSensorUnmute: '❌ Usage: /unmute <sensor_name>',
    selectMute: '🔇 Select a sensor to mute:',
    selectUnmute: '🔔 Select a sensor to unmute:',
    notFound: (name: string) => `❌ Sensor '${name}' not found`,
    muted: (name: string) => `🔇 Notifications muted for ${name}.`,
    alreadyMuted: (name: string) => `ℹ️ ${name} is already muted`,
    unmuted: (name: string) => `🔔 Notifications enabled for ${name}.`,
    notMuted: (name: string) => `ℹ️ ${name} is not muted`,
    muteFailed: '❌ Failed to mute sensor',
    unmuteFailed: '❌ Failed to unmute sensor',
    mutedAll: (count: number) => `🔇 Muted ${count} sensor${count === 1 ? '' : 's'}.`,
    unmutedAll: (count: number) => `🔔 Unmuted ${count} sensor${count === 1 ? '' : 's'}.`,
    noSensorsToMute: 'ℹ️ All sensors are already muted or none are available.',
    noSensorsToUnmute: 'ℹ️ All sensors are already active or none are available.',
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
    helperUpdateRequired:
      '⚠️ Update refused: this release requires a newer root installer bundle. SSH in, run scripts/install.sh from the repo as an administrator, then retry /update.',
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
    cancelButton: '❌ Cancel',
    applying:
      '🔄 Applying system update... I will run a health check and report back when ready.',
    completed: '✅ System update complete.',
    failed: '⚠️ System update failed its health check. SSH in to investigate.',
    cancelled: 'System update cancelled.',
    checkFailed: (reason: string) =>
      `❌ Failed to check for updates: ${reason}`,
  },

  camera: {
    usage:
      'Usage: /camera <snapshot|events [DD.MM.YYYY]|video <id>|photo <id>|enable|disable|status|live [camera]|stop_stream>',
    dashboardTitle: '📹 Camera Dashboard\nSelect an action:',
    dashboardButtons: {
      live: '🔴 Live',
      snapshot: '📸 Take Snapshot',
      browseEvents: '📹 Browse Events',
      eventsToday: '📹 Today\'s Events',
      status: '⚙️ Status',
      close: '❌ Close',
    },
    eventButtons: {
      video: (id: number) => `📹 Video #${id}`,
      photo: (id: number) => `📸 Photo #${id}`,
    },
    browse: {
      menuTitle:
        '📹 Browse Motion Events\nChoose a search mode.\n\nToday, Yesterday, and Pick date will ask for a time range next.',
      buttons: {
        today: 'Today',
        yesterday: 'Yesterday',
        pickDate: 'Pick date',
        latest: 'Latest 20',
        back: '« Back',
        close: '❌ Close',
        cancel: '❌ Cancel',
        video: 'Video',
        photo: 'Photo',
        backToResults: '« Back',
      },
      datePrompt:
        'Send the date to search.\n\nFormat: DD.MM.YYYY\nExample: 08.04.2026',
      timeRangePrompt: (label: string) =>
        `Send the time range for ${label}.\n\nFormat: HH:MM-HH:MM\nExample: 18:00-23:00`,
      invalidDate: 'Date needs to be DD.MM.YYYY.\nExample: 08.04.2026',
      invalidTimeRange:
        'Time range needs to be HH:MM-HH:MM.\nExample: 18:00-23:00',
      invalidTimeOrder:
        'End time must be after start time.\nOvernight ranges are not supported yet.',
      cancelled: 'Browse Events cancelled.',
      expiredInput:
        'This browse search expired. Open Browse Events to start again.',
      resultsExpired: 'That results list expired. Start a new browse search.',
      rangeHeader: (
        dateLabel: string,
        rangeLabel: string,
        count: number,
        hasMore: boolean,
      ) =>
        hasMore
          ? `📹 Events for ${dateLabel}, ${rangeLabel}\nNewest first. Showing the newest 20 matches.\nNarrow the time range if the event is missing.`
          : `📹 Events for ${dateLabel}, ${rangeLabel}\nNewest first. Showing ${count} event${count === 1 ? '' : 's'}.`,
      latestHeader: (count: number) =>
        `📹 Latest Motion Events\nNewest first. Showing ${count} event${count === 1 ? '' : 's'}.`,
      eventLine: (event: BrowseEventLineView) =>
        `#${event.id} ${fmtTime(event.startedAt)} - ${event.camera} - ${event.duration} - ${event.media}`,
      eventButton: (event: BrowseEventButtonView) =>
        `${fmtTime(event.startedAt)} | #${event.id} | ${event.duration} | ${truncateCamera(event.camera)}`,
      cameraFallback: 'camera',
      duration: (
        startedAt: Date | null,
        endedAt: Date | null,
        durationSec: number | null,
      ) => {
        if (!startedAt) return 'unknown';
        if (!endedAt) return 'recording';
        return durationSec === null
          ? presentation.fallback.unknown
          : presentation.units.durationSeconds(durationSec);
      },
      media: (media: BrowseEventMediaView): string => {
        if (media.hasLocalVideo && media.hasPhoto) return 'Video + Photo';
        if (media.hasLocalVideo) return 'Video';
        if (media.hasDriveVideo) {
          return media.hasPhoto ? 'Video + Photo' : 'Video archived on Drive';
        }
        if (media.hasPhoto) return 'Photo';
        return 'Not ready yet';
      },
      emptyRange: (dateLabel: string, rangeLabel: string) =>
        `No motion events found for ${dateLabel}, ${rangeLabel}.\nTry a wider time range.`,
      emptyLatest: 'No motion events recorded yet.',
      actionHeader: (event: BrowseEventActionView) =>
        [
          `📹 Event #${event.id}`,
          `Started: ${fmtDate(event.startedAt, true)}`,
          `Camera: ${event.camera}`,
          `Duration: ${event.duration}`,
          `Media: ${event.media}`,
        ].join('\n'),
      videoUnavailable: (id: number) =>
        `Video for event #${id} is not available anymore.`,
    },
    closed: '📹 Camera dashboard closed.',
    snapshotCaption: (name: string, at: Date) => `📸 ${name} | ${fmtDate(at)}`,
    eventsHeader: (day: Date) => `📹 Motion events for ${format(day, presentation.date.eventDayFormat)}:`,
    eventLine: (e: MotionEventView): string => {
      const time = e.startedAt
        ? format(e.startedAt, presentation.date.eventTimeFormat)
        : presentation.date.eventUnavailableTime;
      const dur = e.durationSec !== null ? presentation.units.eventDurationSeconds(e.durationSec) : '';
      const snap = e.hasSnapshot ? ' 📷' : '';
      return `#${e.id} — ${time}${dur}${snap}`;
    },
    eventsFooter: (count: number) =>
      `${count} event${count === 1 ? '' : 's'}. Use /camera video <id> or /camera photo <id>`,
    eventsNone: (day: Date) => `No motion events on ${format(day, presentation.date.eventDayFormat)}`,
    videoCaption: (id: number, at: Date | null, cam: string) =>
      `📹 Event #${id} | ${fmtDate(at, true)} | ${cam}`,
    photoCaption: (id: number, at: Date | null, cam: string) =>
      `📸 Event #${id} | ${fmtDate(at, true)} | ${cam}`,
    driveLinkFallback: (id: number, remotePath: string | null) =>
      remotePath
        ? `📹 Event #${id} is too large for Telegram.\nIt is archived on Google Drive at:\n${remotePath}`
        : `📹 Event #${id} is too large for Telegram and has no Drive copy yet.`,
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
    live: {
      experimentalLabel: 'Experimental live view',
      opening: '⏳ Opening an experimental live view…',
      opened: (minutes: number) =>
        `🧪 Experimental live view is ready for about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      watchButton: 'Watch live',
      unavailable: '❌ Experimental live view is unavailable right now.',
      sourceUnavailable: '❌ The camera live source is unavailable.',
      stopped: '✅ Live view stopped.',
      noActive: 'ℹ️ No live view is active.',
      expired: 'ℹ️ This live-view link has expired.',
      adminFailure: '⚠️ Experimental live view failed. Check the worker and tunnel diagnostics.',
    },
    /*
     * RTSP source workflow copy.
     *
     * Mandatory in every locale — see `LocaleCatalog`. The workflow asks an
     * administrator to paste an address that usually carries a camera password,
     * and an administrator who cannot read the warning cannot consent to it, so
     * there is no English fallback to degrade into.
     *
     * Keys are semantic, never positional: screens are named for what they show
     * (`overview`, `emptyState`, `detail`), and every closed vocabulary the
     * Camera boundary owns — operational state, policy relationship, failure
     * kind, recovery action — is a `satisfies Record<…>` map, so a member added
     * upstream is a build failure here rather than a missing message at runtime.
     */
    sources: {
      /* ── Camera Dashboard entry ─────────────────────────────────── */
      dashboardButton: '📡 RTSP Sources',

      /* ── Status-first overview ──────────────────────────────────── */
      overview: {
        title: '📡 RTSP camera sources',
        page: (page: number, pageCount: number) => `Page ${page} of ${pageCount}`,
        previous: '‹ Previous',
        next: 'Next ›',
        addCamera: '➕ Add RTSP camera',
      },
      policy: {
        scope: 'Local network only',
        network: (network: { interface: string; cidr: string; family: 4 | 6 }) =>
          `• ${network.interface} · ${network.cidr} (IPv${network.family})`,
        noNetworks: 'No camera network is described right now.',
        state: {
          ready: 'Cameras can be reached on the networks above, and nowhere else.',
          stale: '⚠️ The camera network policy no longer describes this network. Reinstall RTSP to refresh it.',
          unavailable: '⚠️ The camera network policy could not be read. Reinstall RTSP to restore it.',
        },
      },
      emptyState: {
        title: 'No RTSP cameras are configured yet.',
        body: 'An RTSP camera streams from its own address on the local network above. Add one to watch it live.',
        addFirst: '➕ Add first camera',
      },
      progress: {
        testing: '⏳ Testing connection…',
        removing: '⏳ Removing the camera source…',
      },

      /* ── Status vocabulary, keyed by what the Camera boundary says ─ */
      statuses: {
        'configured-verified': '✅ Ready',
        'credentials-required': '🔑 Address required',
        'not-ready': '⏳ Not ready',
        'needs-attention': '⚠️ Needs attention',
      } satisfies Record<RtspSourceOperationalState, string>,
      relationships: {
        allowed: 'inside the camera network',
        blocked: 'outside the camera network',
        unresolved: 'at an address that does not resolve',
      } satisfies Record<RtspSourcePolicyRelationship, string>,
      row: (input: { cameraName: string; status: string }) => `${input.cameraName} · ${input.status}`,

      /* ── One source in detail. Host only: never the identifier. ──── */
      detail: (input: {
        cameraName: string;
        host: string;
        status: string;
        relationship: string;
      }) => [
        input.cameraName,
        `Address: ${input.host}`,
        `Status: ${input.status}`,
        `Network: ${input.relationship}`,
      ].join('\n'),
      reverificationDue: '⚠️ Not verified under the camera network policy now in force. Test the connection.',
      detailButtons: {
        test: '🧪 Test connection',
        changeAddress: '🔗 Change address',
        details: 'ℹ️ Details',
      },
      details: {
        title: 'ℹ️ Connection details',
        body: (input: {
          security: string;
          transport: string;
          profile: string;
          relationship: string;
        }) => [input.security, input.transport, input.profile, `Network: ${input.relationship}`].join('\n'),
        security: {
          none: 'Security: plain RTSP, not encrypted',
          strict: 'Security: RTSPS, certificate verified',
        },
        transports: {
          auto: 'Transport: chosen automatically',
          tcp: 'Transport: TCP',
          udp: 'Transport: UDP',
        },
        profiles: {
          eco: 'Quality: eco',
          balanced: 'Quality: balanced',
          quality: 'Quality: high',
        },
      },

      /* ── Create a camera, or attach a source to an existing one ──── */
      add: {
        title: 'Add an RTSP camera',
        choose: 'Create a new camera, or attach a source to a camera you already have.',
        create: '➕ Create RTSP camera',
        attach: '🔗 Attach to existing camera',
        chooseCamera: 'Choose the camera this source belongs to:',
      },

      /* ── Exact ForceReply prompts ───────────────────────────────── */
      prompts: {
        name: 'Reply to this message with a name for the camera.',
        nameHint: 'Up to 64 characters, and different from every camera you already have.',
        credential: 'Reply to this message with the camera address.',
        replyHint: 'Reply to this exact message. A separate new message will not be read.',
        invalidName: 'That name cannot be used. Reply again with plain text, up to 64 characters.',
        /*
         * Prompt lifecycle. These are messages, not controls: `startAgain` and
         * `cancelButton` are what the administrator presses, and these are what
         * they read when the exact-reply window closed underneath them.
         *
         * The window is a parameter rather than prose. The same ten minutes is
         * already spelled in `privacyNotice`, in the handler's TTL and in the
         * prompt row's `expiresAt`; a fourth copy — in three languages — is
         * where that number goes stale unnoticed.
         */
        expired: (minutes: number) =>
          `⏳ This camera setup expired after ${minutes} minute${minutes === 1 ? '' : 's'}. Open RTSP Sources to start again.`,
        cancelled: 'Camera setup cancelled. Nothing was changed.',
        cancelButton: '❌ Cancel',
      },

      /*
       * Sent immediately before the credential prompt, and the only place the
       * administrator learns what they are about to hand Telegram. Six clauses,
       * each a separate promise: accepted schemes, the networks in force,
       * possible embedded credentials, Telegram's lack of a secret channel,
       * best-effort deletion, and the expiry window.
       */
      privacyNotice: (input: { networks: string; minutes: number }) => [
        '🔒 Before you send the camera address',
        'Only RTSP and strict RTSPS addresses are accepted.',
        `Cameras can be reached on:\n${input.networks}`,
        'The address may contain a username and password.',
        'Telegram has no secret channel — your reply arrives as an ordinary message in this chat.',
        'It is deleted the moment it arrives, but deletion is best effort and can fail.',
        `This prompt expires in ${input.minutes} minute${input.minutes === 1 ? '' : 's'}.`,
      ].join('\n\n'),

      /*
       * Removal has two readings and they are not interchangeable: a camera
       * that exists only to carry a source disappears with it, while a camera
       * that also records keeps everything except its RTSP address.
       */
      removal: {
        confirmCamera: (cameraName: string) =>
          `Remove RTSP camera ${cameraName}?\nThe camera and its stored address are deleted. Recorded events are kept.`,
        confirmSource: (cameraName: string) =>
          `Remove RTSP source from ${cameraName}?\nThe camera stays; only its address and stored credentials are deleted.`,
        removeCameraButton: '🗑 Remove RTSP camera',
        removeSourceButton: '🗑 Remove RTSP source',
        keep: '« Keep it',
        removedCamera: (cameraName: string) => `✅ RTSP camera ${cameraName} was removed.`,
        removedSource: (cameraName: string) => `✅ The RTSP source was removed from ${cameraName}.`,
      },

      outcomes: {
        created: (cameraName: string) => `✅ ${cameraName} is configured and answering.`,
        attached: (cameraName: string) => `✅ The RTSP source is attached to ${cameraName} and answering.`,
        replaced: (cameraName: string) => `✅ The address for ${cameraName} was replaced, and it answered.`,
        tested: (cameraName: string) => `✅ ${cameraName} answered its stored address. Nothing was changed.`,
      },

      /*
       * One message per failure kind the presenter can return, and nothing
       * else: `CameraSourcesHandler` renders `errors[presented.kind]` and never
       * interpolates `error.message`, because most of these failures were
       * produced by a URL that carries the camera password.
       */
      errors: {
        'invalid-address': '❌ That address cannot be used. It must be an RTSP or strict RTSPS address that names a host.',
        'outside-policy': '❌ The camera address is outside the permitted camera networks. It may be on another subnet, or reachable only over IPv6 while the policy allows IPv4 — or the reverse.',
        'name-taken': '❌ Another camera already uses that name. Go back and choose a different one.',
        'host-not-found': '❌ The camera hostname does not resolve. Check the name, or use its address instead.',
        'host-unreachable': '❌ The camera did not answer. Check that it is powered on and on this network.',
        'authentication-failed': '❌ The camera refused the request. Check the username and password — and the stream path, which many cameras reject the same way even when the credentials are right.',
        'tls-verification-failed': '❌ The camera certificate failed verification. Check its hostname and certificate authority.',
        'unsupported-stream': '❌ The camera answered with a stream this device cannot play. Try its substream, or an H.264 profile.',
        'timed-out': '❌ The camera took too long to answer. Check the network, then try again.',
        'feature-unavailable': '❌ RTSP camera support is not available right now, so nothing was changed.',
        'policy-stale': '❌ The camera network policy is no longer the one in force, so nothing was changed. Reinstall RTSP on the current network.',
        'source-stale': '❌ This camera source changed while you were working on it. Nothing was changed — open it again to see its current state.',
        'probe-failed': '❌ The camera could not be verified. Check the address, the credentials and the network.',
      } satisfies Record<CameraSourceFailureKind, string>,
      actions: {
        retry: '↻ Retry',
        'change-address': '🔗 Change address',
        back: '« Back',
        'reinstall-rtsp': '🔁 Reinstall RTSP',
      } satisfies Record<CameraSourceRecoveryAction, string>,

      /* ── Prompt lifecycle ───────────────────────────────────────── */
      startAgain: '↻ Start again',
      /*
       * Deliberately hedged, twice. The only thing the workflow knows is that a
       * deletion call did not succeed — which is indistinguishable from the
       * message having already been gone, and which a later clean deletion never
       * clears. So this neither blames Telegram for refusing nor promises the
       * reply is still there; it asks the administrator to look, which is advice
       * that stays correct in both cases.
       */
      credentialDeletionFailed: (cameraName: string) =>
        `⚠️ Your reply with the address for ${cameraName} may not have been deleted. Please check this chat and delete it yourself if it is still there.`,
      /*
       * Words a user may type instead of pressing Cancel. Stored already
       * normalized — trimmed and lowercased — so the handler compares a
       * normalized reply against them directly rather than re-deriving a rule
       * per locale. The Latin word stays accepted in every language: a phone
       * keyboard is not always set to the interface language.
       */
      cancelSynonyms: ['cancel', 'stop'],
      rtspClosed: '❌ RTSP camera support went offline before the change was saved. Nothing changed.',
      stopFailed: '❌ The camera could not be taken off air, so the change was not saved.',
    },
    adminAlert: {
      daemonDown:
        '🚨 Motion daemon is down and could not be restarted automatically. Camera recording is offline.',
      daemonRecovered: '✅ Motion daemon recovered. Camera recording is back online.',
      gdriveSyncFailing: (error: string) =>
        `⚠️ Google Drive sync failing: ${error}`,
      motionScanFailing: (code: string) =>
        `⚠️ Motion video traversal keeps failing (${code}). New recordings are not being archived.`,
      diskWarning:
        '⚠️ Disk usage is high and approaching the critical threshold. Uploaded media will be cleaned up automatically if it keeps climbing.',
      emergencyDiskCleanup:
        '🚨 Emergency disk cleanup ran: old events/logs were pruned and the motion daemon was stopped to free space.',
      liveStreamRecoveryFailed:
        '⚠️ A stale live-stream process could not be verified and was not stopped.',
    },
  },

  gdrive: {
    usage: 'Usage: /gdrive connect|status|retry|disconnect',
    header: '☁️ Google Drive Status',
    drainStates: DRIVE_DRAIN_LABELS,
    actions: DRIVE_REQUIRED_ACTIONS,
    retryResults: DRIVE_RETRY_RESULTS,
    retryButton: '↻ Retry archive recovery',
    body: (v: GdriveStatusView): string => {
      const lines = [
        `Connection: ${v.connection?.state ?? 'not connected'}`,
        `📦 Used: ${gb(v.quota?.usageBytes ?? null)} / ${gb(v.quota?.limitBytes ?? null)} (${percent(v.quota?.usageBytes ?? null, v.quota?.limitBytes ?? null)})`,
        `Drive / Trash: ${gb(v.quota?.usageInDriveBytes ?? null)} / ${gb(v.quota?.usageInDriveTrashBytes ?? null)}`,
        `📤 Last upload: ${fmtDate(v.last.uploadAtMs === null ? null : new Date(v.last.uploadAtMs))}`,
        `💾 Last backup: ${fmtDate(v.last.backupAtMs === null ? null : new Date(v.last.backupAtMs))}`,
        `🔄 Last reconcile / cleanup: ${fmtDate(v.last.reconcileAtMs === null ? null : new Date(v.last.reconcileAtMs))} / ${fmtDate(v.last.cleanupAtMs === null ? null : new Date(v.last.cleanupAtMs))}`,
        `🔎 Last Motion traversal: ${fmtDate(v.last.motionTraversalAtMs == null ? null : new Date(v.last.motionTraversalAtMs))}`,
        `📝 Last artifact registration: ${fmtDate(v.last.artifactRegistrationAtMs == null ? null : new Date(v.last.artifactRegistrationAtMs))}`,
        `Drain state: ${DRIVE_DRAIN_LABELS[v.drainState]}`,
        `Queued videos: ${v.queue?.queuedVideos ?? 0}`,
        `Retryable videos: ${v.queue?.retryableVideos ?? 0}`,
        `Oldest queued video age: ${formatAgeMs(v.queue?.oldestQueuedVideoAgeMs ?? null)}`,
        `Unhealthy date folders: ${v.queue?.unhealthyDateFolders ?? 0}`,
        `📋 Artifacts: ${Object.values(v.artifacts).reduce((sum, count) => sum + count, 0)}; attempts: ${Object.values(v.attempts).reduce((sum, count) => sum + count, 0)}`,
        `⚠️ Missing / detached: ${v.attempts.missing ?? 0} / ${v.attempts.detached ?? 0}`,
      ];
      if (v.reclamation) lines.push(`🧹 Reclaimed: ${gb(v.reclamation.reclaimedBytes)} (window: ${fmtDate(v.reclamation.windowStartedMs === null ? null : new Date(v.reclamation.windowStartedMs))})`);
      if (v.generations.length > 0) lines.push(`ℹ️ Retired or disconnected generations: ${v.generations.length}`);
      if (v.requiredAction) lines.push(`Required action: ${DRIVE_REQUIRED_ACTIONS[v.requiredAction]}`);
      return lines.join('\n');
    },
    notInstalled: '❌ Google Drive integration is unavailable.',
    notConfigured: '❌ Google Drive is not configured.',
    statusFailed: (_reason: string) => '❌ Failed to check Drive status.',
    statusUnavailable: '❌ Google Drive status is temporarily unavailable.',
    alerts: {
      'reauthorization-required': '⚠️ Google Drive needs administrator reauthorization.',
      'policy-rejected': '⚠️ Google Drive rejected an archive policy operation.',
      'quota-reclamation-required': '⚠️ Google Drive storage needs manual review or reclamation.',
      'remote-object-missing': '⚠️ An archive object is missing and cannot be restored automatically.',
      'remote-object-detached': '⚠️ An archive object changed outside the worker and was detached safely.',
      'retired-archive': '⚠️ A retired archive generation needs administrator review.',
      'upload-failure-prolonged': '⚠️ Archive uploads have been failing for an extended period.',
      'backup-failure-prolonged': '⚠️ Archive backups have been failing for an extended period.',
      'credential-corrupt': '🚨 Google Drive credentials are unavailable or corrupted.',
      'clock-unhealthy': '⚠️ System clock health prevents safe archive maintenance.',
      'local-disk-pressure': '🚨 Local disk pressure threatens archive staging capacity.',
      'folder-branch-unhealthy': '⚠️ An archive date-folder branch needs administrator review.',
      'provider-cooldown-prolonged': '⚠️ Google Drive access has remained in cooldown for an extended period.',
      'provider-capacity-blocked': '⚠️ Google Drive capacity requires administrator action.',
      'backlog-age-prolonged': '⚠️ The archive video backlog has remained pending for an extended period.',
    },
    cleanButton: '🧹 Trigger Clean Now',
  },

  gdriveConnection: {
    guide: `☁️ Connect Google Drive

Home Worker needs an OAuth client created in a Google Cloud project you control. Do not upload a Web or Desktop client.

1. Open Google Cloud Console and sign in with the account that will own this project.
2. Create a project dedicated to this Home Worker installation, or select an existing dedicated project.
3. Open APIs & Services → Library, find Google Drive API, and press Enable.
4. Open Google Auth Platform → Branding. If setup has not started, press Get started. Enter an app name such as “Home Worker,” select a support email, add a contact email, accept the Google API Services User Data Policy, and finish setup. Under Audience, choose External for a personal account or access outside one Google Workspace organization. Choose Internal only when the project belongs to your Workspace organization and the Drive account is a member of that same organization.
5. Open Google Auth Platform → Data Access → Add or remove scopes. Add https://www.googleapis.com/auth/drive.file, then save.
6. If you chose External, open Google Auth Platform → Audience and publish the app so its status is In production. Do not leave an External app in Testing: Google expires Testing authorizations and refresh tokens after seven days. Internal apps do not use this External publishing step.
7. Open Google Auth Platform → Clients → Create client.
8. Set Application type to exactly “TVs and Limited Input devices.” Enter a name such as “Home Worker device” and create it.
9. Download the client JSON. Do not use a Web application or Desktop app JSON.
10. Return to this private chat and send the downloaded JSON using Telegram's document/file attachment. Do not paste its contents, edit it, or forward it from another chat.

Keep the downloaded file private. After reading the Telegram document, the bot will try to delete that message. If Google shows an unverified-app warning, continue only when this is your own project and you recognize the requested drive.file permission. For an Internal app, use only an account in the same Workspace organization as the project.

If setup is interrupted or the bot restarts, press Connect Drive again.`,
    openConsole: 'Open Google Cloud Console',
    uploadPrompt: '☁️ Send the Google OAuth installed-client JSON file as a document. It will be deleted after it is read.',
    authorize: (url: string, code: string) => `Open ${url} and enter this code: ${code}. Then tap Confirm.`,
    confirm: '✅ Confirm account',
    cancel: 'Cancel',
    cancelled: 'Google Drive connection cancelled.',
    invalidClient: '❌ The uploaded file is not a valid Google installed-client JSON document.',
    documentInvalid: '❌ Download a fresh client JSON and send it as a Telegram document.',
    unsupportedClientType: '❌ Create a client of type TVs and Limited Input devices. Web and Desktop clients do not work.',
    clientRejected: '❌ Google rejected this OAuth client. Check that its type is TVs and Limited Input devices and that it still exists and is enabled.',
    setupBusy: '⏳ Another administrator is connecting Drive. Retry this same document later; you do not need to restart setup.',
    setupExpired: '⌛ Drive setup expired. Press Connect Drive and start again.',
    policyBlocked: '❌ Google policy blocked access. Check External/Internal audience selection, Internal organization membership, and Workspace administrator policy.',
    rateLimited: '⏳ Google rate-limited setup. Wait before starting Drive setup again.',
    temporaryUnavailable: '❌ Google Drive or the network is temporarily unavailable. Retry later; your previous Drive connection is unchanged.',
    providerResponse: '❌ Google returned an unexpected response. Update or restart Home Worker and retry; the JSON file is not necessarily invalid.',
    manualDelete: '⚠️ Could not delete the credential document. Please delete it manually.',
    connected: '✅ Google Drive connected.',
    connectionFailed: '❌ Google Drive connection could not be completed. Your previous connection was kept.',
    disconnectPrompt: 'Disconnect Google Drive? Existing archived files will not be deleted.',
    disconnectConfirm: 'Disconnect',
    disconnected: 'Google Drive disconnected. Existing archives were kept.',
    notConnected: 'Google Drive is not connected.',
    authorizationReady: (account: string) => `Google authorization completed for ${account}. Return to the confirmation message to finish connecting.`,
    authorizationPending: 'Google authorization is still in progress. Complete it in the browser, then try again.',
    authorizationFailed: 'Google authorization did not complete. Your previous connection was kept.',
    accountUnavailable: 'the selected Google account',
  },

  settings: {
    title: (threshold: number) =>
      `⚙️ *System Runtime Settings*\n\n*Auto Clean Trigger Threshold:* ${threshold}%\n_(When disk or Drive usage reaches this level, uploaded media and old files are cleaned up automatically.)_\n\nSelect a preset threshold or trigger a cleanup:`,
    updated: (threshold: number) =>
      `✅ Auto clean threshold updated to *${threshold}%*.`,
    buttons: {
      t70: '70%',
      t75: '75%',
      t80: '80%',
      t85: '85%',
      t90: '90%',
      cleanNow: '🧹 Trigger Clean Now',
    },
    invalidThreshold: '⚠️ Invalid threshold: must be between 10% and 99%.',
  },

  clean: {
    triggered: (threshold: number) =>
      `🧹 *Manual Cleanup Triggered*\n\nStorage cleanup executed across local disk and Google Drive (threshold used: *${threshold}%*). Old and uploaded files were checked and pruned.`,
    inProgress: '⏳ A storage cleanup is already in progress. Please try again in a moment.',
    invalidThreshold: '⚠️ Invalid threshold: must be an integer between 10% and 99%.',
    button: '🧹 Trigger Clean Now',
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
    invalidLiveSources: 'Live-source metadata is invalid or contains unsupported fields.',
    summary: (s: ImportSummary & { liveSources?: string[] }): string => {
      const lines = ['📋 Import summary:', ''];
      lines.push(
        s.added.length > 0 ? `➕ Add: ${s.added.join(', ')}` : '➕ Add: none',
      );
      lines.push(
        s.liveSources?.length
          ? `📷 Configure live sources: ${s.liveSources.join(', ')}`
          : '📷 Configure live sources: none',
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
    cancelButton: '❌ Cancel',
    applied: (s: ImportSummary & { liveSources?: string[] }): string =>
      `✅ Config imported. ${s.added.length} added, ${s.updated.length} updated, ${s.archived.length} archived, ${s.liveSources?.length ?? 0} live sources configured without credentials.`,
    applyFailed: '❌ Import failed before any changes were applied.',
    partialFailed: '⚠️ Live-source metadata was applied; sensor import did not complete cleanly and its database changes may also have been applied. Review the current configuration before retrying.',
    sensorOutcomeUncertain: '⚠️ Sensor import did not complete cleanly and its database changes may have been applied. Review the current configuration before retrying.',
    partialRoleChanged: '⚠️ Live-source metadata was applied, but sensor import was stopped because administrator access changed.',
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
      if (!v.archiveRecovered) {
        lines.push('⚠️ Archive recovery failed — video uploads and backups are paused until the next restart.');
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

export const en = deepFreeze(enCatalog);

export interface ConfigDisplay {
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  debounceMs: number;
  severity: SensorSeverity;
}

function formatAgeMs(value: number | null): string {
  if (value === null) return presentation.date.never;
  if (value < 60_000) return `${Math.floor(value / 1_000)}s`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)}m`;
  if (value < 86_400_000) return `${Math.floor(value / 3_600_000)}h`;
  return `${Math.floor(value / 86_400_000)}d`;
}
