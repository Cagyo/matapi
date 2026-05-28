import { format } from 'date-fns';
import { SensorType } from '../sensors/domain/sensor';

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
      '/ping — check bot response',
      '/help — this message',
    ].join('\n'),
    admin: [
      '📖 Available Commands',
      '',
      '/status — sensor status',
      '/logs <sensor> [count] — sensor logs',
      '/ping — check bot response',
      '/help — this message',
      '',
      '🔧 Admin Commands',
      '',
      '/health — system health',
      '/claim_admin — claim admin (first run only)',
    ].join('\n'),
  },
};
