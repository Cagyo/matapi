import { format } from 'date-fns';
import { DbRecovery } from '../database/integrity';
import { SensorSeverity, SensorType } from '../sensors/domain/sensor';
import { ImportSummary } from '../sensors/application/import-sensors.use-case';
import { FeatureStatus } from '../features/domain/feature-status';
import { DepUpdate } from '../system/domain/ports/system-deps.port';
import { User } from '../telegram/domain/user.entity';
import type { LocaleCatalog } from './catalog';
import { deepFreeze } from './freeze';

const presentation = {
  date: {
    format: 'dd.MM.yyyy HH:mm',
    formatWithSeconds: 'dd.MM.yyyy HH:mm:ss',
    timeFormat: 'HH:mm',
    never: 'никогда',
    unavailableTime: '—',
    age: {
      underMinute: ' (меньше минуты назад)',
      minutes: (minutes: number) => ` (${minutes} мин. назад)`,
      hours: (hours: number) => ` (${hours} ч. назад)`,
      days: (days: number) => ` (${days} дн. назад)`,
    },
  },
  fallback: {
    unavailable: 'Н/Д',
    unknown: 'неизвестно',
    digitalOpen: 'ОТКРЫТ',
    digitalOpened: 'ОТКРЫТ',
    digitalClosed: 'ЗАКРЫТ',
  },
  units: {
    gigabytes: 'GB',
    megabytes: 'MB',
    ppm: 'ppm',
    uptime: (days: number, hours: number, minutes: number) => `${days} д ${hours} ч ${minutes} мин`,
    durationSeconds: (seconds: number) => `${seconds} с`,
    eventDurationSeconds: (seconds: number) => ` (${seconds} с)`,
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

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = Math.abs(count) % 10;
  const mod100 = Math.abs(count) % 100;
  return mod10 === 1 && mod100 !== 11
    ? one
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? few
      : many;
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
  const steps = (ru.sensors?.steps as Record<string, Record<string, string>>)?.[stepType ?? 'contact'];
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
    description: 'Интерактивная панель команд',
    usage: '/menu — интерактивная панель команд',
    scope: 'user',
  },
  {
    command: 'status',
    description: 'Состояние датчиков',
    usage: '/status — состояние датчиков',
    scope: 'user',
  },
  {
    command: 'logs',
    description: 'Журнал датчика',
    usage: '/logs <датчик> [количество] — журнал датчика',
    scope: 'user',
  },
  {
    command: 'mute',
    description: 'Отключить уведомления датчика для себя',
    usage: '/mute <датчик> — отключить уведомления датчика для себя',
    scope: 'user',
  },
  {
    command: 'unmute',
    description: 'Включить уведомления датчика для себя',
    usage: '/unmute <датчик> — включить уведомления датчика для себя',
    scope: 'user',
  },
  {
    command: 'quiet_hours',
    description: 'Отключить информационные уведомления',
    usage: '/quiet_hours HH:MM-HH:MM | off — отключить информационные уведомления',
    scope: 'user',
  },
  {
    command: 'camera',
    description: 'Камера и движение',
    usage: '/camera <snapshot|events|video|photo|status> — камера и движение',
    scope: 'user',
  },
  {
    command: 'ping',
    description: 'Проверить ответ бота',
    usage: '/ping — проверить ответ бота',
    scope: 'user',
  },
  {
    command: 'help',
    description: 'Доступные команды и справка',
    usage: '/help — это сообщение',
    scope: 'user',
  },
  {
    command: 'health',
    description: 'Состояние системы',
    usage: '/health — состояние системы',
    scope: 'admin',
  },
  {
    command: 'config',
    description: 'Управление датчиками',
    usage: '/config add|modify|remove — управление датчиками',
    scope: 'admin',
  },
  {
    command: 'cancel',
    description: 'Отменить активный мастер настройки',
    usage: '/cancel — отменить активный мастер настройки',
    scope: 'admin',
  },
  {
    command: 'export_config',
    description: 'Скачать текущую конфигурацию в YAML',
    usage: '/export_config — скачать текущую конфигурацию в YAML',
    scope: 'admin',
  },
  {
    command: 'import_config',
    description: 'Импортировать датчики из файла YAML',
    usage: '/import_config — импортировать датчики из файла YAML',
    scope: 'admin',
  },
  {
    command: 'invite',
    description: 'Создать одноразовый код приглашения',
    usage: '/invite — создать одноразовый код приглашения',
    scope: 'admin',
  },
  {
    command: 'promote',
    description: 'Назначить пользователя администратором',
    usage: '/promote <пользователь> — назначить пользователя администратором',
    scope: 'admin',
  },
  {
    command: 'demote',
    description: 'Снять права администратора',
    usage: '/demote <пользователь> — снять права администратора',
    scope: 'admin',
  },
  {
    command: 'feature',
    description: 'Включить или отключить дополнительные функции',
    usage: '/feature enable|disable|list — управление дополнительными функциями',
    scope: 'admin',
  },
  {
    command: 'update',
    description: 'Загрузить и установить последнюю версию',
    usage: '/update — загрузить и установить последнюю версию',
    scope: 'admin',
  },
  {
    command: 'rollback',
    description: 'Вернуться к предыдущей версии',
    usage: '/rollback — вернуться к предыдущей версии',
    scope: 'admin',
  },
  {
    command: 'system_update',
    description: 'Обновить зависимости ОС',
    usage: '/system_update — обновить зависимости ОС (apt, rclone; мажорные обновления Node выполняются вручную)',
    scope: 'admin',
  },
  {
    command: 'restart',
    description: 'Перезапустить сервис',
    usage: '/restart — перезапустить сервис',
    scope: 'admin',
  },
  {
    command: 'gdrive',
    description: 'Состояние синхронизации с Google Drive',
    usage: '/gdrive status — состояние синхронизации с Google Drive',
    scope: 'admin',
  },
  {
    command: 'gdrive_auth',
    description: 'Настроить аутентификацию Google Drive',
    usage: '/gdrive_auth — настроить или заменить учётные данные Google Drive',
    scope: 'admin',
  },
  {
    command: 'settings',
    description: 'Настройки системы и порог автоочистки',
    usage: '/settings — настройки системы',
    scope: 'user',
  },
  {
    command: 'clean',
    description: 'Запустить очистку хранилища вручную',
    usage: '/clean [порог] — запустить очистку хранилища вручную',
    scope: 'admin',
  },
  {
    command: 'claim_admin',
    description: 'Назначить первого администратора',
    usage: '/claim_admin <токен> — назначить первого администратора',
    scope: 'admin',
  },
];

const PINOUT_SCHEMA = `<pre>📌 Распиновка GPIO Raspberry Pi (BCM)
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

const ruCatalog = {
  presentation,
  commands,
  sensors: {
    steps: {
      contact:     { false: 'Закрыт',         true: 'Открыт',              offline: '❓ Не в сети' },
      leak_hazard: { false: 'Сухо',           true: 'Обнаружена протечка', offline: '❓ Не в сети' },
      alarm:       { false: 'Норма',          true: 'Тревога',             offline: '❓ Не в сети' },
      power:       { false: 'Сеть в норме',   true: 'Отключение',          offline: '❓ Не в сети' },
      motion:      { false: 'Нет движения',   true: 'Движение',            offline: '❓ Не в сети' },
      button:      { false: 'Отпущена',       true: 'Нажата',              offline: '❓ Не в сети' },
    },
    notifications: {
      alarmTriggered: (name: string, state: string) => `🚨 *КРИТИЧЕСКАЯ ТРЕВОГА:* ${name} теперь *${state}*!`,
      alarmResolved:  (name: string, state: string) => `✅ *ТРЕВОГА СНЯТА:* ${name} снова *${state}*.`,
      infoChange:     (name: string, state: string, oldState: string) => `ℹ️ *${name}:* ${state} (было ${oldState})`,
      flappingFault:  (name: string) => `⚠️ *НЕИСПРАВНОСТЬ:* Датчик *${name}* переведён на опрос из-за частых переключений!`,
      viewLogs: '📋 Открыть журнал',
      mqttOffline: '🔴 Брокер MQTT не в сети',
      mqttRecovered: '🟢 Соединение с брокером MQTT восстановлено',
    },
  },
  common: {
    adminRequired: '❌ Требуются права администратора',
    error: (action: string, reason: string) => `❌ Не удалось выполнить действие «${action}»: ${reason}`,
    failure: (reason: string) => `❌ Ошибка: ${reason}`,
    historical: (value: string) => `Историческое значение: ${value}`,
    interrupted: 'Предыдущая операция была прервана. Начните заново.',
    cancelButton: '❌ Отмена',
    backButton: '« Назад',
    closeButton: '❌ Закрыть',
    quietModeButton: '🌙 Тихий режим',
    noActiveWizard: 'ℹ️ Нет активного мастера настройки для отмены.',
  },
  language: {
    prompt: 'Выберите язык:',
    current: (language: string) => `Текущий язык: ${language}`,
    updated: (language: string) => `✅ Язык изменён: ${language}.`,
    buttons: {
      en: 'Английский',
      ru: 'Русский',
      uk: 'Українська',
    },
  },
  claim: {
    success: '✅ Теперь вы администратор этого Home Worker.',
    alreadyClaimed: '❌ У этого Home Worker уже есть администратор.',
    invalidToken: '❌ Недействительный токен назначения администратора. Используйте команду из мастера настройки.',
    notConfigured: '❌ Назначение администратора отключено, пока не задан CLAIM_ADMIN_TOKEN.',
  },
  users: {
    inviteIssued: (code: string) =>
      `🔗 Код приглашения: ${code}\nПередайте его новому пользователю. Ему нужно отправить:\n/start ${code}`,
    inviteFailed: '❌ Не удалось создать код приглашения',
    startNoCode: 'Для регистрации отправьте /start <код_приглашения>',
    invalidCode: '❌ Недействительный код приглашения',
    codeUsed: '❌ Этот код приглашения уже был использован',
    alreadyRegistered: 'Вы уже зарегистрированы',
    welcomed: (name: string) => `✅ Добро пожаловать, ${name}! Вы зарегистрированы как пользователь.`,
    joinedNotice: (name: string) => `👤 ${name} присоединился по вашему коду приглашения.`,
    userNotFound: '❌ Пользователь не найден',
    alreadyAdmin: (name: string) => `ℹ️ ${name} уже администратор`,
    alreadyUser: (name: string) => `ℹ️ ${name} уже обычный пользователь`,
    promoted: (name: string) => `✅ ${name} назначен администратором.`,
    promotedNotice: (admin: string) =>
      `🎉 ${admin} назначил вас администратором.`,
    demoted: (name: string) => `✅ ${name} больше не администратор.`,
    demotedNotice: (admin: string) => `${admin} снял с вас права администратора.`,
    finalAdmin: '❌ Нельзя снять права с последнего администратора.',
    promoteFailed: '❌ Не удалось назначить пользователя администратором',
    demoteFailed: '❌ Не удалось снять права администратора',
    registerFailed: '❌ Не удалось зарегистрировать пользователя',
    missingTarget: (cmd: string) =>
      `❌ Использование: /${cmd} <имя|id:telegram_id>`,
    ambiguousTarget: (
      cmd: string,
      matches: readonly Pick<User, 'telegramId' | 'name'>[],
    ) =>
      `❌ Найдено несколько пользователей. Повторите /${cmd} с id:<telegram_id>: ${matches
        .map((match) => `${match.name} (id:${match.telegramId})`)
        .join(', ')}`,
  },
  feature: {
    usage: '❌ Использование: /feature enable|disable|list [имя_функции]',
    listHeader: '🔧 Дополнительные функции',
    listLine(f: FeatureStatus): string {
      const icon = !f.installed ? '⬜' : f.enabled ? '✅' : '❌';
      const state = f.enabled ? 'включена' : 'выключена';
      const install = f.installed ? 'установлена' : 'не установлена';
      return `${icon} ${f.name} — ${state} (${install})`;
    },
    enabled: (name: string) =>
      `✅ Функция «${name}» включена.\nℹ️ Перезапустите сервис, чтобы полностью её загрузить.`,
    disabled: (name: string) =>
      `✅ Функция «${name}» выключена.\nℹ️ Перезапустите сервис, чтобы полностью её выгрузить.`,
    unknown: (name: string) =>
      `❌ Неизвестная функция «${name}». Используйте /feature list.`,
    notInstalled: (name: string) =>
      `❌ Для функции «${name}» требуются системные зависимости. Повторно запустите скрипт установки с включённой ${name}.`,
    alreadyEnabled: (name: string) => `ℹ️ Функция «${name}» уже включена`,
    alreadyDisabled: (name: string) =>
      `ℹ️ Функция «${name}» уже выключена`,
    enableFailed: '❌ Не удалось включить функцию',
    disableFailed: '❌ Не удалось выключить функцию',
    listFailed: '❌ Не удалось получить список функций',
  },
  status: {
    header: '📊 Состояние системы',
    none: 'Нет настроенных датчиков. Используйте /config для их добавления.',
    line(row: StatusRow): string {
      const icon = TYPE_ICONS[row.type] ?? '•';
      let value = fmtRowValue(row);
      if (!row.online) {
        const offlineStep = (ru.sensors?.steps as Record<string, Record<string, string>>)?.[row.stepType ?? 'contact']?.offline;
        value = offlineStep ?? '❓ Не в сети';
      }
      const ago = fmtAgo(row.lastValueAt);
      let suffix = '';
      if (!row.online) {
        suffix = ` ⚠️ не в сети${ago}`;
      } else if (
        row.type === 'digital' &&
        (row.lastValue === 'true' || row.lastValue === '1') &&
        row.lastValueAt
      ) {
        suffix = ` ⚠️ (с ${fmtTime(row.lastValueAt)}${ago})`;
      } else if (ago) {
        suffix = ago;
      }
      return `${icon} ${row.name}: ${value}${suffix}`;
    },
    footer(allOnline: boolean, offlineCount: number, now: Date): string {
      const head = allOnline
        ? '📡 Все системы в сети'
        : `⚠️ ${offlineCount} ${plural(offlineCount, 'датчик не в сети', 'датчика не в сети', 'датчиков не в сети')}`;
      return `${head} | ${fmtDate(now)}`;
    },
    readFailed: '❌ Не удалось прочитать состояние датчиков',
  },
  ping: {
    pong: (ms: number) => `🏓 Ответ! (${ms} мс)`,
  },
  health: {
    header: '🏥 Состояние системы',
    body(snap: HealthSnapshotView): string {
      const lines = [
        `💾 Диск: ${gb(snap.diskUsedBytes)} / ${gb(snap.diskTotalBytes)} (${percent(
          snap.diskUsedBytes,
          snap.diskTotalBytes,
        )})`,
        `🌡️ Температура CPU: ${snap.cpuTempC !== null ? `${Math.round(snap.cpuTempC)}°C` : 'Н/Д'}`,
        `🧠 Память: ${mb(snap.memoryUsedBytes)} / ${mb(snap.memoryTotalBytes)} (${percent(
          snap.memoryUsedBytes,
          snap.memoryTotalBytes,
        )})`,
        `⏱️ Аптайм: ${fmtUptime(snap.uptimeSec)}`,
        `📊 Размер БД: ${mb(snap.dbSizeBytes)}`,
        `📡 Бот: ${
          snap.botLastUpdateAgoSec === null
            ? 'нет активности'
            : `опрос работает (последнее обновление ${snap.botLastUpdateAgoSec} с назад)`
        }`,
        `🔌 Датчики: ${snap.sensorsOnline}/${snap.sensorsTotal} в сети`,
      ];
      return lines.join('\n');
    },
    collectFailed: '❌ Не удалось собрать сведения о состоянии системы',
  },
  logs: {
    header(name: string, count: number): string {
      return `📋 Журнал ${name} (последние ${count}):`;
    },
    none(name: string): string {
      return `Нет записей журнала для датчика «${name}»`;
    },
    line(entry: LogLineView): string {
      return `${fmtDate(entry.timestamp, true)} [${entry.level.toUpperCase()}] ${entry.message}`;
    },
    stateChange(stepType: string, oldVal: boolean, newVal: boolean): string {
      const steps = (ru.sensors?.steps as Record<string, Record<string, string>>)?.[stepType] || ru.sensors.steps.contact;
      let oldStr = (oldVal ? steps.true : steps.false).toUpperCase();
      let newStr = (newVal ? steps.true : steps.false).toUpperCase();
      if (stepType === 'contact') {
        if (oldStr === 'ОТКРЫТ') oldStr = 'ОТКРЫТ';
        if (newStr === 'ОТКРЫТ') newStr = 'ОТКРЫТ';
      }
      return `Состояние изменилось: ${oldStr} → ${newStr}`;
    },
    debounceTriggered(count: number, windowSec: number): string {
      return `Сработала защита от дребезга (${count} ${plural(count, 'событие', 'события', 'событий')} за ${windowSec} с)`;
    },
    flappingFault(name: string, pin: number): string {
      return `Датчик «${name}» (пин ${pin}) часто переключается. Переход в режим опроса раз в 10 с.`;
    },
    fileName(name: string): string {
      return `журнал_${name}_${format(new Date(), 'yyyy-MM-dd')}.txt`;
    },
    notFound: (name: string) => `❌ Датчик «${name}» не найден`,
    invalidDuration: '❌ Неверный формат периода. Используйте: 30m, 2h, 1d, 7d',
    invalidCount: '❌ Неверное количество. Используйте положительное число.',
    selectSensor: '📋 Выберите датчик, чтобы посмотреть последние записи:',
    readFailed: '❌ Не удалось прочитать журнал',
  },
  help: {
    user: [
      '📖 Доступные команды',
      '',
      ...commands.filter((c) => c.scope === 'user').map((c) => c.usage),
    ].join('\n'),
    admin: [
      '📖 Доступные команды',
      '',
      ...commands.filter((c) => c.scope === 'user').map((c) => c.usage),
      '',
      '🔧 Команды администратора',
      '',
      ...commands.filter((c) => c.scope === 'admin').map((c) => c.usage),
    ].join('\n'),
  },
  menu: {
    title: '🎛️ Интерактивная панель команд\nВыберите категорию или команду:',
    closed: 'Панель команд закрыта.',
    categories: {
      sensors: '📊 Состояние и датчики',
      media: '📷 Камера и медиа',
      admin: '⚙️ Администрирование и настройка',
      lifecycle: '🔄 Обслуживание системы',
    },
    buttons: {
      status: '📊 Состояние',
      health: '🏥 Система',
      logs: '📋 Журнал',
      mute: '🔇 Отключить',
      cameraStatus: '📷 Состояние камеры',
      gdrive: '☁️ Синхронизация Drive',
      config: '⚙️ Настройка',
      settings: '⚙️ Параметры',
      clean: '🧹 Запустить очистку',
      invite: '🔗 Пригласить',
      feature: '🔧 Функции',
      update: '⬆️ Обновить',
      restart: '🔄 Перезапустить',
      exportConfig: '📤 Экспорт конфигурации',
    },
    submenus: {
      configTitle: '⚙️ *Настройка датчиков*\n\nВыберите действие:',
      configAdd: '➕ Добавить датчик',
      configModify: '✏️ Изменить датчик',
      configRemove: '🗑️ Удалить датчик',
      featuresTitle: '🔧 *Управление функциями*\n\nВыберите функцию для просмотра или переключения:',
      featuresList: '📋 Все функции',
      restartConfirmTitle: '⚠️ *Подтвердите перезапуск системы*\n\nПерезапустить сервис?',
      updateConfirmTitle: '⬆️ *Подтвердите обновление системы*\n\nПроверить и установить последние обновления кода?',
      confirmYes: '⚠️ Да, продолжить',
      confirmNo: '❌ Отмена',
      sensorsTitle: '📊 *Действия с датчиками*\n\nВыберите действие:',
      sensorsMute: '🔇 Отключить датчик',
      sensorsUnmute: '🔊 Включить датчик',
      sensorsMuteAll: '🔇 Отключить все',
      sensorsUnmuteAll: '🔊 Включить все',
      systemTitle: '🔄 *Система и обслуживание*\n\nВыберите действие:',
      systemUpdate: '⬆️ Проверить обновления',
      systemRestart: '🔄 Перезапустить сервис',
      systemHealth: '🏥 Состояние системы',
      systemDrive: '☁️ Состояние синхронизации Drive',
      systemSettings: '⚙️ Параметры системы',
      systemClean: '🧹 Запустить очистку',
      systemInvite: '🔗 Создать код приглашения',
      backToMenu: '« Назад',
      quietTitle: '🌙 *Тихий режим (расписание)*\n\nВыберите готовое расписание:',
      quiet22_07: '🌙 22:00 - 07:00 (10 ч)',
      quiet23_06: '🌙 23:00 - 06:00 (8 ч)',
      quiet00_08: '🌙 00:00 - 08:00 (8 ч)',
      quietDisable: '🔔 Отключить тихий режим',
    },
    quietMode: {
      title: '🌙 *Тихий режим*\n\nВыберите время отключения информационных уведомлений:',
      h1: '1 час',
      h4: '4 часа',
      h8: '8 часов',
      off: '🔔 Включить все (обычный режим)',
      activated: (hours: number) => `🌙 *Тихий режим включён*\nИнформационные уведомления отключены на ${hours} ${plural(hours, 'час', 'часа', 'часов')}. Критические тревоги будут доставляться.`,
      deactivated: '🔔 *Тихий режим отключён*\nОбычные уведомления восстановлены.',
    },
    usage: {
      logs: 'Использование: /logs <датчик> [количество] — например, /logs front_door 20',
      mute: 'Использование: /mute <датчик> — например, /mute front_door',
      config: 'Использование: /config add|modify|remove — управление датчиками',
      feature: 'Использование: /feature list|enable|disable [имя] — управление дополнительными функциями',
      update: 'Чтобы обновить сервис до последней версии, отправьте /update',
      restart: 'Чтобы перезапустить сервис, отправьте /restart',
    },
  },
  config: {
    selectModify: '✏️ *Выберите датчик для изменения*\n\nВыберите активный датчик для редактирования:',
    selectRemove: '🗑️ *Выберите датчик для удаления*\n\nВыберите активный датчик для удаления:',
    noActiveSensors: 'ℹ️ Нет активных настроенных датчиков.',
    step1: 'Шаг 1 из 5 — Какой тип датчика?',
    step2: (type: string) => `Шаг 2 из 5 (${type})\n\nИмя датчика?`,
    step3Digital: (name: string, usedPins?: string) =>
      `Шаг 3 из 5 (цифровой: «${name}»)\n\nВыберите доступный пин GPIO.\n\n${PINOUT_SCHEMA}${
        usedPins ? `\n\nУже используются: ${usedPins}` : ''
      }`,
    step4Digital: (name: string, pin: number) => `Шаг 4 из 5 (цифровой: «${name}», пин ${pin})\n\nВыберите тип контакта (класс устройства):`,
    step5Digital: (name: string, pin: number, stepType: string) => `Шаг 5 из 5 (цифровой: «${name}», пин ${pin}, ${stepType})\n\nУровень важности?\n💡 _Подсказка: «Информация» — только запись в журнал; «Предупреждение» — обычное уведомление; «Критический» — срочная тревога._`,
    step3Uart: (name: string) => `Шаг 3 из 5 (UART: «${name}»)\n\nПуть к последовательному порту? (например, /dev/serial0)`,
    step4Uart: (name: string, port: string) => `Шаг 4 из 5 (UART: «${name}», порт ${port})\n\nСкорость передачи?\n💡 _Подсказка: скорость обмена в битах/с. 9600 — стандарт для большинства датчиков CO2._`,
    step5Uart: (name: string, port: string, baud: number) => `Шаг 5 из 5 (UART: «${name}», порт ${port}, ${baud} бод)\n\nПорог предупреждения (ppm)?\n💡 _Подсказка: уровень CO2 в ppm, при котором отправляется предупреждение (например, 1000)._`,
    typeQuestion: 'Какой тип датчика?',
    nameQuestion: 'Имя датчика?',
    pinQuestion: (usedPins?: string) =>
      `GPIO pin number (0–27)?\n\n${PINOUT_SCHEMA}${
        usedPins ? `\n\nУже используются: ${usedPins}` : ''
      }`,
    gpioPickerOnly: 'Выберите одну из доступных кнопок GPIO ниже.',
    noAvailableGpioPins: '❌ Нет доступных пинов GPIO. Удалите или перенастройте цифровой датчик и попробуйте снова.',
    stepTypeQuestion: 'Выберите тип контакта (класс устройства):',
    activeQuestion: 'Активный высокий или низкий уровень?',
    pullQuestion: 'Подтягивающий резистор?',
    severityQuestion: 'Уровень важности?',
    portQuestion: 'Путь к последовательному порту?',
    baudQuestion: 'Скорость передачи?',
    warningQuestion: 'Порог предупреждения (ppm)?',
    criticalQuestion: 'Критический порог (ppm)?\n💡 _Подсказка: критический уровень CO2 должен быть выше порога предупреждения (например, 1500)._',
    debouncePrompt: 'Защита от дребезга (мс)?\n💡 _Подсказка: время игнорирования дребезга кнопки или быстрых переключений (например, 10000 = 10 с)._',
    defaultButton: '⚡ Использовать значения по умолчанию (контакт, информация)',
    invertToggleSuccess: (name: string, newState: string) => `✅ Логическое состояние датчика «${name}» инвертировано. Текущее состояние: ${newState}`,
    removeConfirm: (name: string) =>
      `Удалить датчик «${name}»? Он будет отправлен в архив.`,
    removed: (name: string) => `✅ Датчик «${name}» архивирован.`,
    cancelled: 'Отменено.',
    addedDigital: (
      name: string,
      pin: number,
      stepType: string,
      severity: SensorSeverity,
    ) =>
      `✅ Датчик «${name}» добавлен (GPIO ${pin}, ${stepType}, ${prettySeverity(severity)})`,
    addedUart: (
      name: string,
      port: string,
      baud: number,
      warning: number,
      critical: number,
    ) =>
      `✅ Датчик «${name}» добавлен (UART ${port}, ${baud} бод, предупр.: ${warning}, крит.: ${critical})`,
    modifyHeader: (sensor: ConfigDisplay) => {
      const lines = [
        `Текущая конфигурация «${sensor.name}»:`,
        `Тип: ${prettyType(sensor.type)}`,
      ];
      if (sensor.type === 'digital') {
        const inv = sensor.config.invert ?? sensor.config.activeLow ?? true;
        const pull = sensor.config.pull as string | undefined;
        lines.push(
          `GPIO: ${(sensor.config.pin as number | undefined) ?? '?'}`,
          `Тип контакта: ${(sensor.config.stepType as string | undefined) ?? 'contact'}`,
          `Активный низкий уровень: ${inv === false ? 'Нет' : 'Да'} — срабатывает при ${inv === false ? 'высоком' : 'низком'} уровне сигнала`,
          `Подтяжка: ${prettyPull(pull)} — ${pull === 'none' ? 'нет внутреннего резистора; используйте внешнюю обвязку для стабильности входа' : 'поддерживает стабильность входа при отсутствии подключения'}`,
        );
      } else if (sensor.type === 'uart') {
        lines.push(
          `Порт: ${(sensor.config.port as string | undefined) ?? '?'}`,
          `Скорость: ${(sensor.config.baudRate as number | undefined) ?? '?'}`,
          `Предупр.: ${(sensor.config.thresholds as { warning?: number } | undefined)?.warning ?? '?'} ppm`,
          `Критич.: ${(sensor.config.thresholds as { critical?: number } | undefined)?.critical ?? '?'} ppm`,
        );
      }
      lines.push(
        `Защита от дребезга: ${sensor.debounceMs} мс — кратко игнорирует повторные сигналы`,
        `Уровень важности: ${prettySeverity(sensor.severity)}`,
        '',
        'Что изменить?',
      );
      return lines.join('\n');
    },
    modifyMenuPrompt: 'Что изменить?',
    modifiedField: (field: string) => `✅ Поле «${field}» обновлено. Изменить что-то ещё?`,
    modifyDone: (name: string) => `✅ Датчик «${name}» обновлён.`,
    nameTaken: (name: string) => `❌ Датчик «${name}» уже существует`,
    notFound: (name: string) => `❌ Датчик «${name}» не найден`,
    pinTaken: (pin: number, owner: string) =>
      `❌ GPIO ${pin} уже используется датчиком «${owner}»`,
    invalidPin: '❌ Номер пина GPIO должен быть от 0 до 27',
    invalidName:
      '❌ Недопустимое имя датчика. Используйте только буквы, цифры и подчёркивания.',
    invalidNumber: '❌ Введите корректное число.',
    invalidPinRange: '❌ Неверный номер пина GPIO. Введите число от 0 до 27:',
    invalidThresholdOrder: (warn: number) =>
      `❌ Критический порог должен быть выше порога предупреждения (${warn} ppm). Введите критический порог > ${warn}:`,
    invalidPortPath:
      '❌ Путь к последовательному порту не может быть пустым (например, /dev/ttyUSB0):',
    invalidDebounce:
      '❌ Введите время защиты от дребезга в миллисекундах (0 или больше):',
    invalidPort: '❌ Путь к последовательному порту не может быть пустым.',
    thresholdsOrder: '❌ Порог предупреждения должен быть ниже критического.',
    missingArg: (cmd: string) => `❌ Использование: /config ${cmd} <имя_датчика>`,
    addStarted: 'Запущен /config add — ответьте на вопросы ниже.',
  },
  mute: {
    missingSensor: '❌ Использование: /mute <имя_датчика>',
    missingSensorUnmute: '❌ Использование: /unmute <имя_датчика>',
    selectMute: '🔇 Выберите датчик, для которого нужно отключить уведомления:',
    selectUnmute: '🔔 Выберите датчик, для которого нужно включить уведомления:',
    notFound: (name: string) => `❌ Датчик «${name}» не найден`,
    muted: (name: string) => `🔇 Уведомления для ${name} отключены.`,
    alreadyMuted: (name: string) => `ℹ️ Уведомления для ${name} уже отключены`,
    unmuted: (name: string) => `🔔 Уведомления для ${name} включены.`,
    notMuted: (name: string) => `ℹ️ Уведомления для ${name} не были отключены`,
    muteFailed: '❌ Не удалось отключить уведомления датчика',
    unmuteFailed: '❌ Не удалось включить уведомления датчика',
    mutedAll: (count: number) => `🔇 Отключены уведомления для ${count} ${plural(count, 'датчика', 'датчиков', 'датчиков')}.`,
    unmutedAll: (count: number) => `🔔 Включены уведомления для ${count} ${plural(count, 'датчика', 'датчиков', 'датчиков')}.`,
    noSensorsToMute: 'ℹ️ Все датчики уже отключены или нет доступных датчиков.',
    noSensorsToUnmute: 'ℹ️ Все датчики уже активны или нет доступных датчиков.',
  },
  quietHours: {
    invalidFormat:
      '❌ Используйте формат: /quiet_hours HH:MM-HH:MM (например, 23:00-07:00)',
    invalidTime: '❌ Неверное время. Используйте 24-часовой формат (00:00-23:59)',
    set: (start: string, end: string) =>
      `🌙 Тихие часы установлены: ${start} — ${end}\nИнформационные уведомления отключены. Критические тревоги будут доставляться.`,
    disabled: '☀️ Тихие часы отключены.',
    setFailed: '❌ Не удалось установить тихие часы',
  },
  ota: {
    checking: '🔄 Проверяем обновления...',
    upToDate: 'ℹ️ Установлена актуальная версия.',
    updating: (commit: string) =>
      `🔄 Обновление до ${commit}... Я ненадолго отключусь и сообщу, когда всё будет готово.`,
    inProgress: '⏳ Обновление уже выполняется, подождите.',
    fetchFailed: (reason: string) => `❌ Не удалось проверить обновления: ${reason}`,
    updateSuccess: (commit: string) =>
      `✅ Обновление завершено.\nКоммит: ${commit}`,
    updateFailed: '❌ Обновление не удалось, выполнен откат к предыдущей версии.',
    rollbackStarting: '⏪ Откат к предыдущей версии...',
    rollbackNoTag: '❌ Нет предыдущей версии для отката.',
    rollbackSuccess: (commit: string) => `✅ Выполнен откат к коммиту ${commit}.`,
    rollbackFailed: (reason: string) =>
      `❌ Откат не удался: ${reason}. Возможно, потребуется доступ по SSH.`,
    restarting: '🔄 Перезапуск...',
    restartComplete: '✅ Перезапуск завершён. Аптайм сброшен.',
    restartFailed: (reason: string) => `❌ Перезапуск не удался: ${reason}`,
  },

  systemUpdate: {
    checking: '🔄 Проверяем системные зависимости...',
    allUpToDate: '✅ Все системные зависимости актуальны.',
    header: '🔄 Доступно обновление системы:',
    depLine: (d: DepUpdate): string => {
      switch (d.kind) {
        case 'upgrade':
          return `• ${d.name}: ${d.current} → ${d.available}`;
        case 'node-minor':
          return `• ${d.name}: ${d.current} → ${d.available} (минорное)`;
        case 'node-major':
          return `• ${d.name}: ${d.current} → ${d.available} (мажорное — вручную)`;
        case 'not-installed':
          return `• ${d.name}: не установлено`;
        case 'unknown':
          return `• ${d.name}: версия неизвестна`;
        case 'none':
        default:
          return `• ${d.name}: обновлений нет`;
      }
    },
    nodeMajorWarning: (current: string, desired: string) =>
      `⚠️ Обнаружена смена мажорной версии Node.js (${current} → ${desired}). Требуется ручное вмешательство.`,
    applyButton: 'Применить',
    cancelButton: '❌ Отмена',
    applying:
      '🔄 Применяем обновление системы... Я выполню проверку состояния и сообщу, когда всё будет готово.',
    cancelled: 'Обновление системы отменено.',
    checkFailed: (reason: string) =>
      `❌ Не удалось проверить обновления: ${reason}`,
  },

  camera: {
    usage:
      'Использование: /camera <snapshot|events [DD.MM.YYYY]|video <id>|photo <id>|enable|disable|status>',
    dashboardTitle: '📹 Панель камеры\nВыберите действие:',
    dashboardButtons: {
      snapshot: '📸 Сделать снимок',
      browseEvents: '📹 Просмотреть события',
      eventsToday: '📹 События за сегодня',
      status: '⚙️ Состояние',
      close: '❌ Закрыть',
    },
    eventButtons: {
      video: (id: number) => `📹 Видео #${id}`,
      photo: (id: number) => `📸 Фото #${id}`,
    },
    browse: {
      menuTitle:
        '📹 Просмотр событий движения\nВыберите способ поиска.\n\nДля вариантов «Сегодня», «Вчера» и «Выбрать дату» далее потребуется задать диапазон времени.',
      buttons: {
        today: 'Сегодня',
        yesterday: 'Вчера',
        pickDate: 'Выбрать дату',
        latest: 'Последние 20',
        back: '« Назад',
        close: '❌ Закрыть',
        cancel: '❌ Отмена',
        video: 'Видео',
        photo: 'Фото',
        backToResults: '« Назад',
      },
      datePrompt:
        'Отправьте дату для поиска.\n\nФормат: DD.MM.YYYY\nПример: 08.04.2026',
      timeRangePrompt: (label: string) =>
        `Отправьте диапазон времени для «${label}».\n\nФормат: HH:MM-HH:MM\nПример: 18:00-23:00`,
      invalidDate: 'Дата должна быть в формате DD.MM.YYYY.\nПример: 08.04.2026',
      invalidTimeRange:
        'Диапазон времени должен быть в формате HH:MM-HH:MM.\nПример: 18:00-23:00',
      invalidTimeOrder:
        'Время окончания должно быть позже времени начала.\nДиапазоны через полночь пока не поддерживаются.',
      cancelled: 'Просмотр событий отменён.',
      expiredInput:
        'Срок действия этого поиска истёк. Откройте просмотр событий и начните снова.',
      resultsExpired: 'Срок действия списка результатов истёк. Запустите новый поиск.',
      rangeHeader: (
        dateLabel: string,
        rangeLabel: string,
        count: number,
        hasMore: boolean,
      ) =>
        hasMore
          ? `📹 События за ${dateLabel}, ${rangeLabel}\nСначала новые. Показаны 20 самых новых совпадений.\nЕсли нужного события нет, сузьте диапазон времени.`
          : `📹 События за ${dateLabel}, ${rangeLabel}\nСначала новые. Показано ${count} ${plural(count, 'событие', 'события', 'событий')}.`,
      latestHeader: (count: number) =>
        `📹 Последние события движения\nСначала новые. Показано ${count} ${plural(count, 'событие', 'события', 'событий')}.`,
      eventLine: (event: BrowseEventLineView) =>
        `#${event.id} ${fmtTime(event.startedAt)} - ${event.camera} - ${event.duration} - ${event.media}`,
      eventButton: (event: BrowseEventButtonView) =>
        `${fmtTime(event.startedAt)} | #${event.id} | ${event.duration} | ${truncateCamera(event.camera)}`,
      cameraFallback: 'камера',
      duration: (
        startedAt: Date | null,
        endedAt: Date | null,
        durationSec: number | null,
      ) => {
        if (!startedAt) return presentation.fallback.unknown;
        if (!endedAt) return 'запись';
        return durationSec === null
          ? presentation.fallback.unknown
          : presentation.units.durationSeconds(durationSec);
      },
      media: (media: BrowseEventMediaView): string => {
        if (media.hasLocalVideo && media.hasPhoto) return 'Видео + фото';
        if (media.hasLocalVideo) return 'Видео';
        if (media.hasDriveVideo) {
          return media.hasPhoto ? 'Видео + фото' : 'Видео в архиве Drive';
        }
        if (media.hasPhoto) return 'Фото';
        return 'Ещё не готово';
      },
      emptyRange: (dateLabel: string, rangeLabel: string) =>
        `События движения за ${dateLabel}, ${rangeLabel} не найдены.\nПопробуйте более широкий диапазон времени.`,
      emptyLatest: 'Событий движения пока нет.',
      actionHeader: (event: BrowseEventActionView) =>
        [
          `📹 Событие #${event.id}`,
          `Начало: ${fmtDate(event.startedAt, true)}`,
          `Камера: ${event.camera}`,
          `Длительность: ${event.duration}`,
          `Медиа: ${event.media}`,
        ].join('\n'),
      videoUnavailable: (id: number) =>
        `Видео для события #${id} больше недоступно.`,
    },
    closed: '📹 Панель камеры закрыта.',
    snapshotCaption: (name: string, at: Date) => `📸 ${name} | ${fmtDate(at)}`,
    eventsHeader: (day: Date) => `📹 События движения за ${format(day, 'dd.MM.yyyy')}:`,
    eventLine: (e: MotionEventView): string => {
      const time = e.startedAt ? format(e.startedAt, 'HH:mm:ss') : '--:--:--';
      const dur = e.durationSec !== null ? presentation.units.eventDurationSeconds(e.durationSec) : '';
      const snap = e.hasSnapshot ? ' 📷' : '';
      return `#${e.id} — ${time}${dur}${snap}`;
    },
    eventsFooter: (count: number) =>
      `${count} ${plural(count, 'событие', 'события', 'событий')}. Используйте /camera video <id> или /camera photo <id>`,
    eventsNone: (day: Date) => `Нет событий движения за ${format(day, 'dd.MM.yyyy')}`,
    videoCaption: (id: number, at: Date | null, cam: string) =>
      `📹 Событие #${id} | ${fmtDate(at, true)} | ${cam}`,
    photoCaption: (id: number, at: Date | null, cam: string) =>
      `📸 Событие #${id} | ${fmtDate(at, true)} | ${cam}`,
    driveLinkFallback: (id: number, remotePath: string | null) =>
      remotePath
        ? `📹 Событие #${id} слишком велико для Telegram.\nОно находится в архиве Google Drive:\n${remotePath}`
        : `📹 Событие #${id} слишком велико для Telegram, и его копии в Drive пока нет.`,
    statusHeader: '📹 Состояние камеры',
    statusBody: (v: CameraStatusView): string =>
      [
        `Движение: ${v.running ? '✅ Работает' : '❌ Остановлен'}`,
        `Последнее событие: ${fmtDate(v.lastEventAt)}`,
        `Локальное хранилище: ${mb(v.localStorageBytes)}`,
        `Событий сегодня: ${v.eventsToday}`,
      ].join('\n'),
    motionStarted: '✅ Демон Motion запущен.',
    motionStopped: '✅ Демон Motion остановлен.',
    alreadyRunning: 'ℹ️ Демон Motion уже работает.',
    cameraNotFound: (name: string) => `❌ Камера «${name}» не найдена.`,
    noCameras: '❌ Нет настроенных камер.',
    motionNotRunning: '❌ Демон Motion не запущен. Администратор: /camera enable',
    snapshotFailed: '❌ Не удалось сделать снимок.',
    invalidDate: '❌ Неверная дата. Используйте формат: DD.MM.YYYY',
    eventNotFound: (id: number) => `❌ Событие #${id} не найдено.`,
    videoUnavailable: '❌ Видео больше недоступно.',
    noSnapshotForEvent: (id: number) => `❌ Для события #${id} нет снимка.`,
    snapshotFileGone: '❌ Файл снимка больше недоступен.',
    startFailed: (reason: string) => `❌ Не удалось запустить демон Motion: ${reason}`,
    stopFailed: (reason: string) => `❌ Не удалось остановить демон Motion: ${reason}`,
    notInstalled: '❌ Motion не установлен. Повторите установку с функцией камеры.',
    adminAlert: {
      daemonDown:
        '🚨 Демон Motion остановлен и не был автоматически перезапущен. Запись с камеры недоступна.',
      daemonRecovered: '✅ Демон Motion восстановлен. Запись с камеры снова доступна.',
      gdriveSyncFailing: (error: string) =>
        `⚠️ Синхронизация с Google Drive не удаётся: ${error}`,
      diskWarning:
        '⚠️ Диск почти заполнен и приближается к критическому порогу. Если использование продолжит расти, загруженные медиафайлы будут удаляться автоматически.',
      emergencyDiskCleanup:
        '🚨 Выполнена экстренная очистка диска: старые события и журналы удалены, демон Motion остановлен для освобождения места.',
    },
  },

  gdrive: {
    usage: 'Использование: /gdrive status',
    header: '☁️ Состояние Google Drive',
    body: (v: GdriveStatusView): string => {
      const lines = [
        `📦 Использовано: ${gb(v.usedBytes)} / ${gb(v.totalBytes)} (${percent(v.usedBytes, v.totalBytes)})`,
        `📤 Последняя загрузка: ${fmtDate(v.lastUploadAt)}`,
        `📋 Ожидают загрузки: ${v.pendingUploads} ${plural(v.pendingUploads, 'файл', 'файла', 'файлов')}`,
        v.failedUploads > 0 && v.lastError
          ? `⚠️ Неудачных загрузок: ${v.failedUploads} (последняя ошибка: ${v.lastError})`
          : `⚠️ Неудачных загрузок: ${v.failedUploads}`,
        `🗑️ Автоочистка: включена (минимальный возраст: ${v.cleanupMinAgeDays} ${plural(v.cleanupMinAgeDays, 'день', 'дня', 'дней')})`,
      ];
      if (v.failedUploads >= 5) {
        lines.push(`🚨 Проблема с синхронизацией — ${v.failedUploads} ошибок подряд`);
      }
      return lines.join('\n');
    },
    notInstalled: '❌ rclone не установлен.',
    notConfigured: '❌ Google Drive не настроен. Запустите rclone config.',
    statusFailed: (reason: string) => `❌ Не удалось проверить состояние Drive: ${reason}`,
    cleanButton: '🧹 Запустить очистку',
  },

  gdriveAuth: {
    prompt: (sshHost: string) =>
      '☁️ *Настройка аутентификации Google Drive*\n\n' +
      'Вставьте ниже раздел конфигурации rclone `[gdrive]` или загрузите файл `rclone.conf`.\n\n' +
      'Чтобы настроить Drive напрямую на Pi, выполните на своём ноутбуке:\n' +
      `\`ssh pi@${sshHost} sudo -H -u homeworker env RCLONE_CONFIG=/home/homeworker/.config/rclone/rclone.conf rclone config\`\n\n` +
      'Создайте или обновите удалённое хранилище `gdrive` с типом `drive`. На Pi без графического интерфейса ответьте `n` на вопрос об аутентификации в браузере; если rclone выведет `rclone authorize "drive"`, выполните эту команду на компьютере с браузером и вставьте токен в сеанс SSH.\n\n' +
      'После прямой настройки отправьте здесь /cancel, затем выполните /gdrive status.',
    success: (used: string, total: string) =>
      `✅ Google Drive подключён!\n📦 ${used} / ${total}`,
    failed: (reason: string) =>
      `❌ Не удалось обновить аутентификацию: ${reason}\nПредыдущая конфигурация восстановлена.`,
    notInstalled:
      '❌ rclone не установлен. Повторите установку с функцией камеры.',
    alreadyInProgress: '⏳ Обновление аутентификации уже выполняется. Отправьте /cancel для отмены.',
    cancelled: '☁️ Настройка аутентификации Google Drive отменена.',
    invalidSnippet:
      '❌ Это не похоже на раздел конфигурации rclone. Ожидается заголовок `[gdrive]`.',
    button: '☁️ Настроить аутентификацию GDrive',
  },

  settings: {
    title: (threshold: number) =>
      `⚙️ *Параметры работы системы*\n\n*Порог запуска автоочистки:* ${threshold}%\n_(Когда использование диска или Drive достигнет этого уровня, загруженные медиафайлы и старые файлы будут очищаться автоматически.)_\n\nВыберите готовый порог или запустите очистку:`,
    updated: (threshold: number) =>
      `✅ Порог автоочистки изменён на *${threshold}%*.`,
    buttons: {
      t70: '70%',
      t75: '75%',
      t80: '80%',
      t85: '85%',
      t90: '90%',
      cleanNow: '🧹 Запустить очистку',
    },
    invalidThreshold: '⚠️ Неверный порог: он должен быть от 10% до 99%.',
  },

  clean: {
    triggered: (threshold: number) =>
      `🧹 *Запущена ручная очистка*\n\nОчистка выполнена на локальном диске и в Google Drive (использован порог: *${threshold}%*). Старые и загруженные файлы проверены и удалены при необходимости.`,
    inProgress: '⏳ Очистка хранилища уже выполняется. Повторите попытку через некоторое время.',
    invalidThreshold: '⚠️ Неверный порог: требуется целое число от 10% до 99%.',
    button: '🧹 Запустить очистку',
  },

  exportConfig: {
    caption: '📄 Текущая конфигурация. Отредактируйте и отправьте обратно через /import_config.',
    failed: '❌ Не удалось экспортировать конфигурацию.',
  },

  importConfig: {
    prompt: 'Отправьте файл конфигурации YAML.',
    invalidFormat: '❌ Неверный формат файла. Отправьте файл .yml.',
    tooLarge: '❌ Файл слишком большой. Отправьте файл конфигурации размером до 1 МБ.',
    parseError: (details: string) => `❌ Ошибка разбора YAML: ${details}`,
    validationFailed: (errors: string[]): string =>
      [
        '❌ Проверка конфигурации не пройдена:',
        '',
        ...errors.map((e) => `• ${e}`),
        '',
        'Исправьте и загрузите файл повторно.',
      ].join('\n'),
    noChanges: 'ℹ️ Конфигурация совпадает с текущей. Применять нечего.',
    summary: (s: ImportSummary): string => {
      const lines = ['📋 Итоги импорта:', ''];
      lines.push(
        s.added.length > 0 ? `➕ Добавить: ${s.added.join(', ')}` : '➕ Добавить: нет',
      );
      lines.push(
        s.updated.length > 0
          ? `🔄 Обновить: ${s.updated.map((u) => `${u.name} (${u.detail})`).join(', ')}`
          : '🔄 Обновить: нет',
      );
      lines.push(
        s.archived.length > 0
          ? `🗄️ Архивировать: ${s.archived.join(', ')}`
          : '🗄️ Архивировать: нет',
      );
      lines.push('', 'Применить изменения?');
      return lines.join('\n');
    },
    applyButton: 'Применить',
    cancelButton: '❌ Отмена',
    applied: (s: ImportSummary): string =>
      `✅ Конфигурация импортирована. Добавлено: ${s.added.length}, обновлено: ${s.updated.length}, архивировано: ${s.archived.length}.`,
    cancelled: 'Импорт отменён. Изменения не внесены.',
    failed: (reason: string) =>
      `❌ Импорт не удался: ${reason}. Изменения не внесены.`,
  },

  system: {
    online: (v: SystemOnlineView): string => {
      const lines = ['🟢 Система в сети', `🔌 Датчики: ${v.sensorsOnline}/${v.sensorsTotal} в сети`];
      if (v.dbRecovery === 'restored_from_backup') {
        lines.push('⚠️ База данных восстановлена из локальной резервной копии после повреждения.');
      } else if (v.dbRecovery === 'recreated_empty') {
        lines.push('⚠️ База данных создана заново пустой после повреждения — повторно импортируйте конфигурацию.');
      }
      if (!v.clockSynchronized) {
        lines.push('⚠️ Системные часы не синхронизированы — ранние метки времени могут быть неточными.');
      }
      lines.push(fmtDate(v.now));
      return lines.join('\n');
    },
    goingOffline: '🔴 Система отключается.',
  },
} satisfies LocaleCatalog;

export const ru = deepFreeze(ruCatalog);

function prettyType(type: SensorType): string {
  switch (type) {
    case 'digital':
      return 'Цифровой';
    case 'uart':
      return 'UART';
    case 'mqtt':
      return 'MQTT';
    case 'camera':
      return 'Камера';
  }
}

function prettySeverity(severity: SensorSeverity): string {
  switch (severity) {
    case 'info':
      return 'Информация';
    case 'warning':
      return 'Предупреждение';
    case 'critical':
      return 'Критический';
  }
}

function prettyPull(pull: string | undefined): string {
  switch (pull) {
    case 'up':
      return 'Вверх';
    case 'down':
      return 'Вниз';
    case 'none':
      return 'Нет';
    default:
      return 'Вверх';
  }
}

export interface ConfigDisplay {
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  debounceMs: number;
  severity: SensorSeverity;
}
