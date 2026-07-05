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

function fmtAgo(date: Date | null | undefined): string {
  if (!date) return '';
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 0) return '';
  if (diffSec < 60) return ' (<1m ago)';
  if (diffSec < 3600) return ` (${Math.floor(diffSec / 60)}m ago)`;
  if (diffSec < 86400) return ` (${Math.floor(diffSec / 3600)}h ago)`;
  return ` (${Math.floor(diffSec / 86400)}d ago)`;
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

function fmtDigital(value: string | null, stepType?: string, online = true): string {
  if (!online || value === null) return 'unknown';
  const steps = (en.sensors?.steps as Record<string, Record<string, string>>)?.[stepType ?? 'contact'];
  if (steps) {
    if (value === 'true' || value === '1') return steps.true ?? 'OPENED';
    if (value === 'false' || value === '0') return steps.false ?? 'CLOSED';
  }
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
      return fmtDigital(row.lastValue, row.stepType, row.online);
    case 'uart':
      return fmtUart(row.lastValue, row.thresholdLevel);
    default:
      return row.lastValue ?? 'unknown';
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
    usage: '/camera <snapshot|events|video|photo|status> — camera & motion',
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
    usage: '/feature enable|disable|list — toggle optional features',
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
    usage: '/system_update — update OS dependencies (apt, rclone, node)',
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
    description: 'Google Drive sync status',
    usage: '/gdrive status — Google Drive sync status',
    scope: 'admin',
  },
  {
    command: 'claim_admin',
    description: 'Claim admin (first run only)',
    usage: '/claim_admin — claim admin (first run only)',
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

export const en = {
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
    },
  },
  common: {
    adminRequired: '❌ Admin access required',
    error: (action: string, reason: string) => `❌ Failed to ${action}: ${reason}`,
    interrupted: 'Previous operation was interrupted. Please start again.',
    cancelButton: '❌ Cancel',
    backButton: '« Back',
    closeButton: '❌ Close',
    quietModeButton: '🌙 Quiet Mode',
    noActiveWizard: 'ℹ️ No active configuration wizard to cancel.',
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
    selectSensor: '📋 Select a sensor to view recent logs:',
    readFailed: '❌ Failed to read logs',
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
      mute: '🔇 Mute',
      cameraStatus: '📷 Camera Status',
      gdrive: '☁️ Drive Sync',
      config: '⚙️ Config',
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
      systemTitle: '🔄 *System & Maintenance*\n\nSelect an operation:',
      systemUpdate: '⬆️ Check for Updates',
      systemRestart: '🔄 Restart Worker',
      systemHealth: '🏥 System Health',
      systemDrive: '☁️ Drive Sync Status',
      systemInvite: '🔗 Create Invite Code',
      backToMenu: '« Back to Dashboard',
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
      feature: 'Usage: /feature list|enable|disable [name] — toggle optional features',
      update: 'To update the worker to the latest version, send /update',
      restart: 'To restart the worker, send /restart',
    },
  },
  config: {
    selectModify: '✏️ *Select Sensor to Modify*\n\nChoose an active sensor to edit its configuration:',
    selectRemove: '🗑️ *Select Sensor to Remove*\n\nChoose an active sensor to delete:',
    noActiveSensors: 'ℹ️ No active sensors configured.',
    step1: 'Step 1 of 5 — What type of sensor?',
    step2: (type: string) => `Step 2 of 5 (${type})\n\nSensor name?`,
    step3Digital: (name: string, usedPins?: string) =>
      `Step 3 of 5 (Digital: "${name}")\n\nGPIO pin number (0–27)?\n\n${PINOUT_SCHEMA}${
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
        `Type: ${prettyType(sensor.type)}`,
      ];
      if (sensor.type === 'digital') {
        const inv = sensor.config.invert ?? sensor.config.activeLow ?? true;
        lines.push(
          `GPIO: ${(sensor.config.pin as number | undefined) ?? '?'}`,
          `Step Type: ${(sensor.config.stepType as string | undefined) ?? 'contact'}`,
          `Invert (Active Low): ${inv === false ? 'No' : 'Yes'}`,
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
    dashboardTitle: '📹 Camera Dashboard\nSelect an action below:',
    dashboardButtons: {
      snapshot: '📸 Take Snapshot',
      eventsToday: '📹 Today\'s Events',
      status: '⚙️ Status',
      close: '❌ Close',
    },
    eventButtons: {
      video: (id: number) => `📹 Video #${id}`,
      photo: (id: number) => `📸 Photo #${id}`,
    },
    closed: '📹 Camera dashboard closed.',
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
