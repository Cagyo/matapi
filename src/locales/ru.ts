import { format } from 'date-fns';
import type { DbRecovery } from '../database/integrity';
import type { SensorSeverity, SensorType } from '../sensors/domain/sensor';
import type { ImportSummary } from '../sensors/application/import-sensors.use-case';
import type { DepUpdate } from '../system/domain/ports/system-deps.port';
import type { User } from '../telegram/domain/user.entity';
import type {
  ArchiveDrainState,
  ArchiveRequiredAction,
} from '../archive/application/use-cases/report-drive-status.use-case';
import type { RetryDriveArchiveResult } from '../archive/application/use-cases/retry-drive-archive.use-case';
import type { LocaleCatalog } from './catalog';
import { deepFreeze } from './freeze';

const presentation = {
  date: {
    format: 'dd.MM.yyyy HH:mm',
    formatWithSeconds: 'dd.MM.yyyy HH:mm:ss',
    timeFormat: 'HH:mm',
    eventDayFormat: 'dd.MM.yyyy',
    eventTimeFormat: 'HH:mm:ss',
    eventUnavailableTime: '--:--:--',
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
  config: {
    sensorTypes: {
      digital: 'Цифровой',
      uart: 'UART',
      mqtt: 'MQTT',
      camera: 'Камера',
    },
    severities: {
      info: 'Информация',
      warning: 'Предупреждение',
      critical: 'Критический',
    },
    pulls: {
      up: 'Вверх',
      down: 'Вниз',
      none: 'Нет',
      default: 'Вверх',
    },
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

const DRIVE_DRAIN_LABELS: Record<ArchiveDrainState, string> = {
  active: 'активная загрузка',
  idle: 'ожидание',
  'cooling-down': 'пауза провайдера',
  'branch-blocked': 'ветка папок заблокирована',
  'quota-blocked': 'квота исчерпана',
  'capacity-blocked': 'лимит ёмкости',
  'policy-blocked': 'политика заблокирована',
  'clock-blocked': 'системные часы заблокированы',
  'reauthorization-required': 'требуется повторная авторизация',
};

const DRIVE_REQUIRED_ACTIONS: Record<NonNullable<ArchiveRequiredAction>, string> = {
  'restore-date-folder': 'Восстановите нужную папку даты, затем повторите.',
  'free-drive-space': 'Освободите место в Drive; восстановление будет проверено автоматически.',
  'fix-capacity-then-retry': 'Устраните ограничение ёмкости Drive, затем повторите.',
  'fix-policy-then-retry': 'Устраните блокировку политики Drive, затем повторите.',
  'fix-system-clock': 'Исправьте системные часы перед возобновлением архивации.',
  reauthorize: 'Повторно подключите Google Drive через /gdrive connect.',
};

const DRIVE_RETRY_RESULTS: Record<RetryDriveArchiveResult, string> = {
  scheduled: '✅ Восстановление архива Drive запланировано.',
  stale: '↻ Состояние Drive изменилось. Обновите статус и повторите попытку.',
  'automatic-quota-probe': 'ℹ️ Восстановление места Drive будет проверено автоматически.',
  reauthorize: 'ℹ️ Повторно подключите Google Drive через /gdrive connect.',
  'nothing-blocked': 'ℹ️ Сейчас ничего не заблокировано.',
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
    usage: '/camera <snapshot|events|video|photo|status|live|stop_stream> — камера и движение',
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
    usage: '/feature list|install|enable|disable <имя> — управление дополнительными функциями',
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
    usage: '/system_update — обновить разрешённые пакеты ОС (обновления Node выполняются вручную)',
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
    description: 'Подключить, проверить или отключить Google Drive',
    usage: '/gdrive connect|status|disconnect — управление Google Drive',
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
      watchLive: '📺 Смотреть вживую',
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
    updateFailed: 'Не удалось изменить язык. Попробуйте ещё раз.',
    retryLanguageChange: 'Повторить смену языка',
    returnToMore: '« Ещё',
    restoreMoreFailed: 'Язык изменён, но раздел «Ещё» не удалось открыть.',
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
  home: {
    title: '🏠 Дом',
    verdicts: {
      attention: (count: number) => `⚠️ Внимания требуют датчики: ${count}`,
      unavailable: '⚠️ Мониторинг недоступен',
      normal: '✅ Всё в норме',
    },
    state: {
      counts: (known: number, unknown: number) => `Состояния: известно ${known} · неизвестно ${unknown}`,
      absent: 'Состояния: показаний датчиков пока нет',
    },
    health: {
      counts: (online: number, total: number) => `Датчики на связи: ${online} из ${total}`,
      absent: 'Мониторинг: завершённых проверок ещё нет',
      stale: 'Мониторинг: последняя проверка устарела',
      checking: '⏳ Проверка мониторинга…',
      failed: 'Мониторинг: последняя проверка завершилась ошибкой',
    },
    buttons: {
      sensors: '📊 Датчики',
      camera: '📷 Камера',
      notifications: '🔔 Уведомления',
      more: '⋯ Ещё',
      checkNow: '↻ Проверить',
    },
    notifications: {
      normal: 'Уведомления: обычный режим',
      quietHours: (until: string) => `Уведомления: тихий режим до ${until}`,
      timedPause: (until: Date) => `Уведомления: пауза до ${fmtTime(until)}`,
      legacyPause: 'Уведомления: включена устаревшая пауза',
      pausedTargets: (count: number) => `Уведомления: приостановлено целей: ${count}`,
      title: '🔔 Уведомления',
      quietHoursSummary: (start: string | null, end: string | null) => start && end ? `Тихие часы: ${start}–${end}` : 'Тихие часы: выключены',
      legacyMutedSummary: 'Включена устаревшая пауза',
      mutedTargetsSummary: (count: number) => `Приостановлено целей: ${count}`,
      preset22To07: '22:00–07:00',
      preset23To06: '23:00–06:00',
      preset00To08: '00:00–08:00',
      presetOff: 'Выключить тихие часы',
      targetSettings: '🎯 Настройки целей',
      pause: '⏸ Приостановить уведомления',
      resume: '▶ Возобновить уведомления',
      undoQuietHours: '↩ Отменить тихие часы',
      targetsTitle: '🎯 Цели уведомлений',
      targetsPage: (page: number, pageCount: number, total: number) => `Страница ${page} из ${pageCount} · целей: ${total}`,
      targetsEmpty: 'Нет доступных целей уведомлений.',
      targetTitle: '🎯 Цель уведомлений',
      targetMuted: 'Уведомления для этой цели приостановлены',
      targetActive: 'Уведомления для этой цели активны',
      mute: '🔇 Приостановить уведомления',
      unmute: '🔊 Возобновить уведомления',
      pauseTitle: '⏸ Приостановить уведомления',
      pausePrompt: 'Выберите длительность паузы для некритичных уведомлений:',
      pauseHours: (hours: number) => `${hours} ч.`,
      pauseConfirmation: (hours: number) => `Приостановить некритичные уведомления на ${hours} ч.?`,
      confirmPause: 'Подтвердить паузу',
    },
    sensors: {
      title: '📊 Датчики',
      row: (name: string, state: string) => `• ${name}: ${state}`,
      page: (page: number, pageCount: number, total: number) => `Страница ${page} из ${pageCount} · датчиков: ${total}`,
      clamp: (page: number) => `Список изменился; показана страница ${page}.`,
      attention: (names: readonly string[]) => `Требуют внимания: ${names.join(' · ')}`,
      attentionShown: (shown: number, total: number) => `Показано ${shown} из ${total}`,
      emptyMember: 'Датчики не настроены. Попросите администратора добавить датчик.',
      emptyAdmin: 'Датчики не настроены.',
      setupSensors: '⚙️ Настроить датчики',
      previous: '‹ Назад',
      next: 'Вперёд ›',
      back: '« Назад',
      home: '🏠 Дом',
    },
    common: {
      back: '« Назад',
      home: '🏠 Дом',
    },
    workflow: {
      backTo: (destination: string) => `Назад к ${destination}`,
      cancel: (workflow: string) => `Отменить ${workflow}`,
      home: 'Дом',
      workContinues: (work: string) => `${work} · работа продолжается`,
      unfinishedSetupExpired: 'Незавершённая настройка истекла после перезапуска.',
      retryReturn: 'Повторить возврат',
      returnUnavailable: 'Возврат временно недоступен.',
      outcomeNotice: (outcome: string) => outcome,
    },
    navigation: {
      backTo: {
        notifications: '« Уведомления',
        'notification-targets': '« Настройки целей',
        'pause-duration': '« Уведомления',
        history: '« Ещё',
        more: '« Ещё',
        'admin-tools': '« Инструменты администратора',
        'admin-storage': '« Хранилище и резервные копии',
        'admin-system': '« Система',
      },
    },
    history: {
      title: '🗂 История',
      logs: '📜 Журналы',
      applicationLogs: '🧾 Журнал приложения',
      errors: '❌ Ошибки',
      exportCsv: '⬇ Экспорт CSV',
    },
    more: {
      title: '⋯ Ещё',
      history: '🗂 История',
      settings: '⚙️ Мои настройки',
      help: '❓ Справка',
      adminTools: '🛠 Инструменты администратора',
    },
    adminTools: {
      title: '🛠 Инструменты администратора',
      sensorSetup: '⚙️ Настройка датчиков',
      storage: '💾 Хранилище и резервные копии',
      system: '🖥 Система',
      invite: '👤 Создать приглашение',
      features: '🔧 Функции',
    },
    adminSensorSetup: {
      title: '⚙️ Настройка датчиков',
      add: '➕ Добавить',
      modify: '✏️ Изменить',
      remove: '🗑 Удалить',
      import: '⬆ Импорт',
      export: '⬇ Экспорт',
    },
    adminStorage: {
      title: '💾 Хранилище и резервные копии',
      driveStatus: '☁️ Статус Drive',
      connectDrive: '🔗 Подключить Drive',
      cleanup: '🧹 Очистить хранилище',
    },
    adminSystem: {
      title: '🖥 Система',
      health: '❤️ Состояние',
      packages: '📦 Системные пакеты',
      restart: '🔄 Перезапустить worker',
      cleanupThreshold: '🧹 Порог очистки',
    },
    adminCleanupThreshold: {
      title: '🧹 Порог очистки',
      threshold: (value: number, current: number) => `${value}%${value === current ? ' ✓' : ''}`,
    },
    confirmation: {
      cleanup: 'Очистить хранилище?',
      restart: 'Перезапустить worker?',
      confirmCleanup: 'Подтвердить очистку',
      confirmRestart: 'Подтвердить перезапуск',
    },
    cleanupResult: {
      executed: (threshold: number | null) => threshold === null ? 'Очистка запущена.' : `Очистка запущена при ${threshold}%.`,
      inProgress: 'Очистка уже выполняется.',
      failed: 'Не удалось запустить очистку.',
    },
    recovery: {
      stale: 'Этот Дом больше не активен.',
      updating: 'Этот Дом обновляется. Повторите через мгновение.',
      unavailable: 'Дом временно недоступен. Используйте прямую команду и повторите попытку.',
      openNewHome: '🏠 Открыть новый Дом',
      retryReturn: 'Повторить возврат',
      closed: 'Мониторинг Дома закрыт.',
    },
    legacyNotifications: {
      title: '🔔 Уведомления',
      muteSensors: '🔇 Отключить датчики',
      unmuteSensors: '🔊 Включить датчики',
      quietHours: '🌙 Тихие часы',
    },
  },
  feature: {
    names: { digital: 'Цифровые входы', uart: 'Датчик CO₂ UART', zigbee: 'Zigbee', motion: 'Камера Motion', rtsp: 'Камера RTSP' },
    description: { digital: 'поддержка цифровых входов GPIO', uart: 'поддержка датчика CO₂ UART', zigbee: 'поддержка моста Zigbee MQTT', motion: 'запись камерой Motion', rtsp: 'среда прямой трансляции RTSP' },
    stale: { disabled: (name: string) => `${name} отключена.`, attention: (name: string) => `${name} требует внимания.`, installing: (name: string) => `${name} ещё устанавливается.`, unavailable: (name: string) => `${name} недоступна.` },
    state: { 'not-installed': 'не установлена', 'installed-off': 'выключена', enabled: 'включена', 'needs-attention': 'требует внимания', installing: 'устанавливается' },
    impact: { dependencies: { gpiod: 'gpiod (GPIO)', uart: 'поддержка UART', mosquitto: 'Mosquitto', motion: 'Motion', 'rtsp-runtime': 'среда RTSP' }, controls: { 'digital-sensors': 'цифровые датчики', 'uart-sensors': 'датчики UART', 'mqtt-sensors': 'датчики MQTT', 'motion-camera': 'камеру Motion', 'live-streams': 'прямые трансляции' }, monitoring: { 'sensor-work': 'мониторинг датчиков', 'camera-work': 'мониторинг камер' } },
    attention: { 'inconsistent-state': 'несогласованное состояние', 'readiness-failed': 'проверка готовности не прошла', 'install-failed': 'установка не удалась', 'partial-state-uncertain': 'состояние требует восстановления', 'restart-required': 'нужен перезапуск', 'helper-update-required': 'нужно обновить установщик' },
    usage: '❌ Использование: /feature list|install|enable|disable <имя>',
    listHeader: '🔧 Дополнительные функции',
    listButton: (name: string, state: string) => `${name} — ${state}`,
    listBack: '« Функции',
    reinstallAction: '🔁 Переустановить в текущей сети',
    reinstallNotice: 'Камеры, источники и сохранённые учётные данные сохраняются. Трансляции остановятся до конца переустановки.',
    downtime: { worker: 'Worker кратко перезапустится.', supervisor: 'Служба кратко перезапустится.', host: 'Требуется перезагрузка Pi.' },
    detail: ({ name, description, state, dependencies, controls, monitoring, downtime, attention }: { name: string; description: string; state: string; dependencies: string; controls: string; monitoring: string; downtime: string; attention: string | null }) => [name, description, `Состояние: ${state}`, `Зависимости: ${dependencies}`, `Управляет: ${controls}`, `Мониторинг: ${monitoring}`, downtime, attention ? `Внимание: ${attention}` : ''].filter(Boolean).join('\n'),
    confirmation: { install: (name: string, scope: string) => `Установить ${name} — ${scope}`, reinstall: (name: string, scope: string) => `Переустановить ${name} — ${scope}`, enable: (name: string, scope: string) => `Включить ${name} — ${scope}`, disable: (name: string, scope: string) => `Выключить ${name} — ${scope}`, verify: (name: string, _scope: string) => `Проверить ${name}` },
    restartScope: { worker: 'перезапуск worker', supervisor: 'перезапуск службы', host: 'перезагрузка Pi' },
    failure: { 'request-invalid': 'некорректный запрос установки', 'request-publish-failed': 'не удалось поставить запрос в очередь', 'local-network-unavailable': 'нет подходящей локальной сети', 'network-policy-generation-failed': 'не удалось подготовить сетевую политику', 'dependency-install-failed': 'не удалось установить зависимости', 'privileged-verification-failed': 'не пройдена привилегированная проверка', 'application-verification-failed': 'не пройдена проверка приложения', 'partial-state-uncertain': 'состояние требует восстановления', 'helper-version-mismatch': 'нужно обновить установщик', 'result-invalid': 'некорректный результат установщика', interrupted: 'установка прервана' },
    preRestart: (name: string, scope: string) => `⏳ ${name} готова. Запускается ${scope}; итоговый результат придёт после восстановления.`,
    progress: { installing: (name: string) => `⏳ Устанавливается ${name}. Результат будет отправлен позже.`, reinstalling: (name: string) => `⏳ ${name} переустанавливается в текущей сети. Результат будет отправлен позже.` },
    outcome: { success: (name: string) => `✅ ${name}: готово.`, failure: (name: string, reason: string) => `❌ ${name}: ошибка (${reason}).`, genericFailure: (name: string) => `❌ Не удалось завершить ${name}.`, recoveredSuccess: (name: string) => `Восстановлен успешный результат для ${name}.`, recoveredFailure: (name: string, reason: string) => `Восстановлен ошибочный результат для ${name} (${reason}).` },
    recovery: { stale: 'Эта кнопка функций больше не актуальна. Откройте список снова.', unavailable: 'Управление функциями временно недоступно.' },
    busy: (name: string) => `${name} уже устанавливается.`,
    errors: { installStart: (name: string) => `❌ Не удалось поставить ${name} в очередь.`, notInstalled: (name: string) => `❌ ${name} не установлена.`, inconsistent: (name: string) => `❌ ${name} требует восстановления перед изменением.`, alreadyEnabled: (name: string) => `${name} уже включена.`, alreadyDisabled: (name: string) => `${name} уже выключена.`, restartFailed: (name: string, scope: string) => `❌ ${name} изменена, но не удалось запустить: ${scope}.`, reinstallUnavailable: (name: string) => `❌ Сейчас ${name} нельзя переустановить.` },
    verificationFailed: (name: string) => `❌ ${name} не прошла проверку готовности.`,
    unknown: (name: string) =>
      `❌ Неизвестная функция «${name}». Используйте /feature list.`,
    listFailed: '❌ Не удалось получить список функций',
  },
  setupWizard: {
    featureDescriptions: {
      rtsp: 'Экспериментальная прямая MJPEG-трансляция Motion',
    },
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
    application: {
      outputCaption: '📄 Журнал приложения — до 200 последних строк.',
      errorCaption: '📄 Ошибки приложения — до 200 последних строк.',
      outputEmpty: 'Вывод приложения отсутствует.',
      errorEmpty: 'Ошибки приложения отсутствуют.',
      truncated: '⚠️ Старые строки пропущены из-за ограничения безопасности в 2 МиБ.',
      unavailable: '❌ Журналы приложения сейчас недоступны.',
      invalidArguments: '❌ Используйте /logs app или /logs error без дополнительных аргументов.',
    },
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
  csv: {
    selectTarget: '📄 Выберите историю датчика для экспорта:',
    empty: 'Нет доступных историй датчиков для экспорта.',
    invalidCount: '❌ Неверное количество строк CSV. Введите целое число от 1 до 5000.',
    invalidSelection: '❌ Выбранная история CSV больше недоступна. Выберите снова.',
    notFound: '❌ Выбранная история датчика не найдена.',
    noRows: 'ℹ️ У выбранного датчика нет строк истории для экспорта.',
    rowTooLarge: '❌ Выбранная строка истории слишком велика для экспорта.',
    fileTooLarge: '❌ CSV-файл слишком велик для экспорта.',
    malformedTimestamp: '❌ В выбранной строке истории неверная метка времени.',
    staging: '⏳ Экспорт CSV готовится. Вы можете вернуться на главную, не отменяя его.',
    inProgress: '⏳ Экспорт CSV из этого списка уже выполняется.',
    failed: '❌ Не удалось экспортировать CSV.',
    caption: '📄 Экспорт истории датчика в CSV.',
    previousPage: '‹ Назад',
    nextPage: 'Далее ›',
    disabledTarget: (name: string) => `⏸️ ${name} (отключён)`,
    archivedTarget: (name: string) => `🗄️ ${name} (архивирован)`,
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
      exportCsv: '📄 Экспорт CSV',
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
      sensorsExportCsv: '📄 Экспорт CSV',
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
      feature: 'Использование: /feature list|install|enable|disable <имя> — управление дополнительными функциями',
      update: 'Чтобы обновить сервис до последней версии, отправьте /update',
      restart: 'Чтобы перезапустить сервис, отправьте /restart',
    },
  },
  config: {
    selectModify: '✏️ *Выберите датчик для изменения*\n\nВыберите активный датчик для редактирования:',
    selectRemove: '🗑️ *Выберите датчик для удаления*\n\nВыберите активный датчик для удаления:',
    noActiveSensors: 'ℹ️ Нет активных настроенных датчиков.',
    cancelSensorSetup: 'Отменить настройку датчиков',
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
      `✅ Датчик «${name}» добавлен (GPIO ${pin}, ${stepType}, ${presentation.config.severities[severity]})`,
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
        `Тип: ${presentation.config.sensorTypes[sensor.type]}`,
      ];
      if (sensor.type === 'digital') {
        const inv = sensor.config.invert ?? sensor.config.activeLow ?? true;
        const pull = sensor.config.pull as string | undefined;
        lines.push(
          `GPIO: ${(sensor.config.pin as number | undefined) ?? '?'}`,
          `Тип контакта: ${(sensor.config.stepType as string | undefined) ?? 'contact'}`,
          `Активный низкий уровень: ${inv === false ? 'Нет' : 'Да'} — срабатывает при ${inv === false ? 'высоком' : 'низком'} уровне сигнала`,
          `Подтяжка: ${presentation.config.pulls[pull as keyof typeof presentation.config.pulls] ?? presentation.config.pulls.default} — ${pull === 'none' ? 'нет внутреннего резистора; используйте внешнюю обвязку для стабильности входа' : 'поддерживает стабильность входа при отсутствии подключения'}`,
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
        `Уровень важности: ${presentation.config.severities[sensor.severity]}`,
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
    helperUpdateRequired:
      '⚠️ Обновление отклонено: этому релизу нужен более новый корневой установщик. Зайдите по SSH, запустите scripts/install.sh из репозитория от имени администратора, затем повторите /update.',
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
    completed: '✅ Обновление системы завершено.',
    failed: '⚠️ Системное обновление не прошло проверку состояния. Проверьте через SSH.',
    cancelled: 'Обновление системы отменено.',
    checkFailed: (reason: string) =>
      `❌ Не удалось проверить обновления: ${reason}`,
  },

  camera: {
    usage:
      'Использование: /camera <snapshot|events [DD.MM.YYYY]|video <id>|photo <id>|enable|disable|status|live [камера]|stop_stream>',
    dashboardTitle: '📹 Панель камеры\nВыберите действие:',
    dashboardButtons: {
      live: '🔴 Прямой эфир',
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
    eventsHeader: (day: Date) => `📹 События движения за ${format(day, presentation.date.eventDayFormat)}:`,
    eventLine: (e: MotionEventView): string => {
      const time = e.startedAt
        ? format(e.startedAt, presentation.date.eventTimeFormat)
        : presentation.date.eventUnavailableTime;
      const dur = e.durationSec !== null ? presentation.units.eventDurationSeconds(e.durationSec) : '';
      const snap = e.hasSnapshot ? ' 📷' : '';
      return `#${e.id} — ${time}${dur}${snap}`;
    },
    eventsFooter: (count: number) =>
      `${count} ${plural(count, 'событие', 'события', 'событий')}. Используйте /camera video <id> или /camera photo <id>`,
    eventsNone: (day: Date) => `Нет событий движения за ${format(day, presentation.date.eventDayFormat)}`,
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
    live: {
      experimentalLabel: 'Экспериментальный прямой просмотр',
      opening: '⏳ Открываем экспериментальный прямой просмотр…',
      opened: (minutes: number) =>
        `🧪 Экспериментальный прямой просмотр доступен примерно ${minutes} мин.`,
      watchButton: 'Смотреть в реальном времени',
      unavailable: '❌ Экспериментальный прямой просмотр сейчас недоступен.',
      sourceUnavailable: '❌ Прямая трансляция с камеры недоступна.',
      stopped: '✅ Прямой просмотр остановлен.',
      noActive: 'ℹ️ Активного прямого просмотра нет.',
      expired: 'ℹ️ Срок действия ссылки на прямой просмотр истёк.',
      adminFailure: '⚠️ Сбой экспериментального прямого просмотра. Проверьте worker и диагностику туннеля.',
    },
    /*
     * RTSP-источники: обязательный раздел без отката на английский. Ключи
     * совпадают с `en.camera.sources` — см. `LocaleCatalog` и тесты паритета.
     */
    sources: {
      dashboardButton: '📡 RTSP-источники',

      overview: {
        title: '📡 RTSP-источники камер',
        page: (page: number, pageCount: number) => `Страница ${page} из ${pageCount}`,
        previous: '‹ Назад',
        next: 'Вперёд ›',
        addCamera: '➕ Добавить RTSP-камеру',
      },
      policy: {
        scope: 'Только локальная сеть',
        network: (network: { interface: string; cidr: string; family: 4 | 6 }) =>
          `• ${network.interface} · ${network.cidr} (IPv${network.family})`,
        noNetworks: 'Сейчас ни одна сеть камер не описана.',
        state: {
          ready: 'Камеры доступны только в сетях выше и больше нигде.',
          stale: '⚠️ Политика сети камер больше не описывает эту сеть. Переустановите RTSP, чтобы обновить её.',
          unavailable: '⚠️ Не удалось прочитать политику сети камер. Переустановите RTSP, чтобы восстановить её.',
        },
      },
      emptyState: {
        title: 'RTSP-камеры пока не настроены.',
        body: 'RTSP-камера передаёт поток со своего адреса в локальной сети выше. Добавьте камеру, чтобы смотреть её вживую.',
        addFirst: '➕ Добавить первую камеру',
      },
      progress: {
        testing: '⏳ Проверяем подключение…',
        removing: '⏳ Удаляем источник камеры…',
      },

      statuses: {
        'configured-verified': '✅ Готово',
        'credentials-required': '🔑 Нужен адрес',
        'not-ready': '⏳ Не готово',
        'needs-attention': '⚠️ Требует внимания',
      },
      relationships: {
        allowed: 'внутри сети камер',
        blocked: 'вне сети камер',
        unresolved: 'по адресу, который не удаётся разрешить',
      },
      row: (input: { cameraName: string; status: string }) => `${input.cameraName} · ${input.status}`,

      detail: (input: {
        cameraName: string;
        host: string;
        status: string;
        relationship: string;
      }) => [
        input.cameraName,
        `Адрес: ${input.host}`,
        `Статус: ${input.status}`,
        `Сеть: ${input.relationship}`,
      ].join('\n'),
      reverificationDue: '⚠️ Не проверено при действующей политике сети камер. Проверьте подключение.',
      detailButtons: {
        test: '🧪 Проверить подключение',
        changeAddress: '🔗 Изменить адрес',
        details: 'ℹ️ Подробности',
      },
      details: {
        title: 'ℹ️ Параметры подключения',
        body: (input: {
          security: string;
          transport: string;
          profile: string;
          relationship: string;
        }) => [input.security, input.transport, input.profile, `Сеть: ${input.relationship}`].join('\n'),
        security: {
          none: 'Защита: обычный RTSP, без шифрования',
          strict: 'Защита: RTSPS, сертификат проверяется',
        },
        transports: {
          auto: 'Транспорт: выбирается автоматически',
          tcp: 'Транспорт: TCP',
          udp: 'Транспорт: UDP',
        },
        profiles: {
          eco: 'Качество: экономное',
          balanced: 'Качество: сбалансированное',
          quality: 'Качество: высокое',
        },
      },

      add: {
        title: 'Добавить RTSP-камеру',
        choose: 'Создайте новую камеру или подключите источник к уже существующей.',
        create: '➕ Создать RTSP-камеру',
        attach: '🔗 Подключить к существующей камере',
        chooseCamera: 'Выберите камеру, которой принадлежит этот источник:',
      },

      prompts: {
        name: 'Ответьте на это сообщение названием камеры.',
        nameHint: 'До 64 символов и отличное от названий всех уже добавленных камер.',
        credential: 'Ответьте на это сообщение адресом камеры.',
        replyHint: 'Ответьте именно на это сообщение. Отдельное новое сообщение прочитано не будет.',
        invalidName: 'Такое название использовать нельзя. Ответьте ещё раз обычным текстом, до 64 символов.',
        expired: (minutes: number) =>
          `⏳ Эта настройка камеры истекла через ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}. Откройте RTSP-источники, чтобы начать заново.`,
        cancelled: 'Настройка камеры отменена. Ничего не изменено.',
        cancelButton: '❌ Отмена',
      },

      privacyNotice: (input: { networks: string; minutes: number }) => [
        '🔒 Прежде чем отправить адрес камеры',
        'Принимаются только адреса RTSP и строгого RTSPS.',
        `Камеры доступны в сетях:\n${input.networks}`,
        'Адрес может содержать имя пользователя и пароль.',
        'У Telegram нет секретного канала — ваш ответ придёт обычным сообщением в этот чат.',
        'Оно удаляется сразу же, но удаление выполняется по возможности и может не сработать.',
        `Срок действия запроса — ${input.minutes} ${plural(input.minutes, 'минута', 'минуты', 'минут')}.`,
      ].join('\n\n'),

      removal: {
        confirmCamera: (cameraName: string) =>
          `Удалить RTSP-камеру ${cameraName}?\nКамера и сохранённый адрес будут удалены. Записанные события сохранятся.`,
        confirmSource: (cameraName: string) =>
          `Удалить RTSP-источник у камеры ${cameraName}?\nКамера останется; будут удалены только её адрес и сохранённые учётные данные.`,
        removeCameraButton: '🗑 Удалить RTSP-камеру',
        removeSourceButton: '🗑 Удалить RTSP-источник',
        keep: '« Оставить',
        removedCamera: (cameraName: string) => `✅ RTSP-камера ${cameraName} удалена.`,
        removedSource: (cameraName: string) => `✅ RTSP-источник удалён у камеры ${cameraName}.`,
      },

      outcomes: {
        created: (cameraName: string) => `✅ Камера ${cameraName} настроена и отвечает.`,
        attached: (cameraName: string) => `✅ RTSP-источник подключён к камере ${cameraName} и отвечает.`,
        replaced: (cameraName: string) => `✅ Адрес камеры ${cameraName} заменён, и она ответила.`,
        tested: (cameraName: string) => `✅ Камера ${cameraName} ответила по сохранённому адресу. Ничего не изменено.`,
      },

      errors: {
        'invalid-address': '❌ Этот адрес использовать нельзя. Нужен адрес RTSP или строгого RTSPS с указанием узла.',
        'outside-policy': '❌ Адрес камеры вне разрешённых сетей камер. Камера может быть в другой подсети или доступна только по IPv6, тогда как политика разрешает IPv4 — либо наоборот.',
        'name-taken': '❌ Другая камера уже использует это название. Вернитесь назад и выберите другое.',
        'host-not-found': '❌ Имя узла камеры не разрешается. Проверьте имя или укажите адрес.',
        'host-unreachable': '❌ Камера не ответила. Проверьте, включена ли она и находится ли в этой сети.',
        'authentication-failed': '❌ Камера отклонила запрос. Проверьте имя пользователя и пароль — а также путь потока: многие камеры отклоняют его так же, даже когда учётные данные верны.',
        'tls-verification-failed': '❌ Сертификат камеры не прошёл проверку. Проверьте имя узла и центр сертификации.',
        'unsupported-stream': '❌ Камера ответила потоком, который это устройство не может воспроизвести. Попробуйте её дополнительный поток или профиль H.264.',
        'timed-out': '❌ Камера отвечала слишком долго. Проверьте сеть и попробуйте ещё раз.',
        'feature-unavailable': '❌ Поддержка RTSP-камер сейчас недоступна, поэтому ничего не изменено.',
        'policy-stale': '❌ Политика сети камер больше не является действующей, поэтому ничего не изменено. Переустановите RTSP в текущей сети.',
        'source-stale': '❌ Этот источник камеры изменился, пока вы с ним работали. Ничего не изменено — откройте его снова, чтобы увидеть текущее состояние.',
        'probe-failed': '❌ Не удалось проверить камеру. Проверьте адрес, учётные данные и сеть.',
      },
      actions: {
        retry: '↻ Повторить',
        'change-address': '🔗 Изменить адрес',
        back: '« Назад',
        'reinstall-rtsp': '🔁 Переустановить RTSP',
      },

      startAgain: '↻ Начать заново',
      credentialDeletionFailed: (cameraName: string) =>
        `⚠️ Возможно, ваш ответ с адресом камеры ${cameraName} не был удалён. Проверьте этот чат и удалите его сами, если он ещё там.`,
      cancelSynonyms: ['cancel', 'отмена', 'отменить', 'стоп'],
      rtspClosed: '❌ Поддержка RTSP-камер отключилась до сохранения изменения. Ничего не изменено.',
      stopFailed: '❌ Не удалось снять камеру с эфира, поэтому изменение не сохранено.',
    },
    adminAlert: {
      daemonDown:
        '🚨 Демон Motion остановлен и не был автоматически перезапущен. Запись с камеры недоступна.',
      daemonRecovered: '✅ Демон Motion восстановлен. Запись с камеры снова доступна.',
      gdriveSyncFailing: (error: string) =>
        `⚠️ Синхронизация с Google Drive не удаётся: ${error}`,
      motionScanFailing: (code: string) =>
        `⚠️ Обход видео Motion продолжает завершаться ошибкой (${code}). Новые записи не архивируются.`,
      diskWarning:
        '⚠️ Диск почти заполнен и приближается к критическому порогу. Если использование продолжит расти, загруженные медиафайлы будут удаляться автоматически.',
      emergencyDiskCleanup:
        '🚨 Выполнена экстренная очистка диска: старые события и журналы удалены, демон Motion остановлен для освобождения места.',
      liveStreamRecoveryFailed:
        '⚠️ Устаревший процесс прямой трансляции не удалось проверить, поэтому он не был остановлен.',
    },
  },

  gdrive: {
    usage: 'Использование: /gdrive connect|status|retry|disconnect',
    header: '☁️ Состояние Google Drive',
    drainStates: DRIVE_DRAIN_LABELS,
    actions: DRIVE_REQUIRED_ACTIONS,
    retryResults: DRIVE_RETRY_RESULTS,
    retryButton: '↻ Повторить восстановление архива',
    body: (v: GdriveStatusView): string => {
      const lines = [
        `Подключение: ${v.connection?.state ?? 'не подключено'}`,
        `📦 Использовано: ${gb(v.quota?.usageBytes ?? null)} / ${gb(v.quota?.limitBytes ?? null)} (${percent(v.quota?.usageBytes ?? null, v.quota?.limitBytes ?? null)})`,
        `📤 Последняя загрузка: ${fmtDate(v.last.uploadAtMs === null ? null : new Date(v.last.uploadAtMs))}`,
        `💾 Последняя резервная копия: ${fmtDate(v.last.backupAtMs === null ? null : new Date(v.last.backupAtMs))}`,
        `🔎 Последний обход Motion: ${fmtDate(v.last.motionTraversalAtMs == null ? null : new Date(v.last.motionTraversalAtMs))}`,
        `📝 Последняя регистрация артефакта: ${fmtDate(v.last.artifactRegistrationAtMs == null ? null : new Date(v.last.artifactRegistrationAtMs))}`,
        `Состояние очереди: ${DRIVE_DRAIN_LABELS[v.drainState]}`,
        `Видео в очереди: ${v.queue?.queuedVideos ?? 0}`,
        `Видео для повтора: ${v.queue?.retryableVideos ?? 0}`,
        `Возраст старейшего видео: ${formatAgeMs(v.queue?.oldestQueuedVideoAgeMs ?? null)}`,
        `Нездоровых папок дат: ${v.queue?.unhealthyDateFolders ?? 0}`,
        `📋 Артефактов: ${Object.values(v.artifacts).reduce((sum, count) => sum + count, 0)}; попыток: ${Object.values(v.attempts).reduce((sum, count) => sum + count, 0)}`,
        `⚠️ Отсутствуют / отсоединены: ${v.attempts.missing ?? 0} / ${v.attempts.detached ?? 0}`,
      ];
      if (v.requiredAction) lines.push(`Требуемое действие: ${DRIVE_REQUIRED_ACTIONS[v.requiredAction]}`);
      return lines.join('\n');
    },
    notInstalled: '❌ Интеграция Google Drive недоступна.',
    notConfigured: '❌ Google Drive не настроен.',
    statusFailed: (_reason: string) => '❌ Не удалось проверить состояние Drive.',
    statusUnavailable: '❌ Состояние Google Drive временно недоступно.',
    alerts: {
      'reauthorization-required': '⚠️ Google Drive требует повторной авторизации администратора.',
      'policy-rejected': '⚠️ Google Drive отклонил операцию политики архива.',
      'quota-reclamation-required': '⚠️ Хранилище Google Drive требует проверки или очистки.',
      'remote-object-missing': '⚠️ Объект архива отсутствует и не может быть восстановлен автоматически.',
      'remote-object-detached': '⚠️ Объект архива изменён вне worker и безопасно отсоединён.',
      'retired-archive': '⚠️ Выведенное из использования поколение архива требует проверки.',
      'upload-failure-prolonged': '⚠️ Загрузка архива долгое время не выполняется.',
      'backup-failure-prolonged': '⚠️ Резервное копирование архива долгое время не выполняется.',
      'credential-corrupt': '🚨 Учётные данные Google Drive недоступны или повреждены.',
      'clock-unhealthy': '⚠️ Состояние системных часов не позволяет безопасное обслуживание архива.',
      'local-disk-pressure': '🚨 Давление на локальный диск угрожает промежуточному хранилищу архива.',
      'folder-branch-unhealthy': '⚠️ Ветка папок архива по датам требует проверки администратора.',
      'provider-cooldown-prolonged': '⚠️ Доступ к Google Drive длительное время остаётся на паузе.',
      'provider-capacity-blocked': '⚠️ Ёмкость Google Drive требует действия администратора.',
      'backlog-age-prolonged': '⚠️ Очередь архивных видео слишком долго остаётся необработанной.',
    },
    cleanButton: '🧹 Запустить очистку',
  },

  gdriveConnection: {
    guide: `☁️ Подключение Google Drive

Home Worker нужен OAuth-клиент в контролируемом вами проекте Google Cloud. Не отправляйте клиент Web или Desktop.

1. Откройте Google Cloud Console и войдите в аккаунт владельца проекта.
2. Создайте отдельный проект для этой установки Home Worker или выберите существующий отдельный проект.
3. Откройте APIs & Services → Library, найдите Google Drive API и нажмите Enable.
4. Откройте Google Auth Platform → Branding. Если настройка ещё не начата, нажмите Get started. Укажите имя, например “Home Worker”, адрес поддержки и контактный адрес, примите Google API Services User Data Policy и завершите настройку. В Audience выберите External для личного аккаунта или доступа вне одной организации Google Workspace. Выбирайте Internal только если проект принадлежит вашей организации Workspace, а аккаунт Drive состоит в той же организации.
5. Откройте Google Auth Platform → Data Access → Add or remove scopes. Добавьте https://www.googleapis.com/auth/drive.file и сохраните.
6. Для External откройте Google Auth Platform → Audience и опубликуйте приложение со статусом In production. Не оставляйте External в Testing: Google прекращает такие авторизации и refresh-токены через семь дней. Для Internal этот шаг публикации не нужен.
7. Откройте Google Auth Platform → Clients → Create client.
8. Установите Application type точно “TVs and Limited Input devices”, задайте имя, например “Home Worker device”, и создайте клиент.
9. Скачайте JSON клиента. Не используйте JSON приложения Web или Desktop.
10. Вернитесь в этот личный чат и отправьте скачанный JSON как документ/файл Telegram. Не вставляйте его содержимое, не редактируйте файл и не пересылайте его из другого чата.

Храните файл в тайне. После чтения бот попытается удалить сообщение. Если Google покажет предупреждение о непроверенном приложении, продолжайте только для собственного проекта, когда вы узнаёте разрешение drive.file. Для Internal используйте аккаунт из той же организации Workspace.

Если настройка прервана или бот перезапущен, снова нажмите «Подключить Drive».`,
    openConsole: 'Открыть Google Cloud Console',
    uploadPrompt: '☁️ Отправьте JSON-файл OAuth установленного клиента Google как документ. После чтения он будет удалён.',
    authorize: (url: string, code: string) => `Откройте ${url} и введите код: ${code}. Затем нажмите «Подтвердить».`,
    confirm: '✅ Подтвердить аккаунт',
    cancel: 'Отмена',
    cancelled: 'Подключение Google Drive отменено.',
    invalidClient: '❌ Загруженный файл не является корректным JSON установленного клиента Google.',
    documentInvalid: '❌ Скачайте свежий JSON клиента и отправьте его как документ Telegram.',
    unsupportedClientType: '❌ Создайте клиент типа TVs and Limited Input devices. Клиенты Web и Desktop не работают.',
    clientRejected: '❌ Google отклонил OAuth-клиент. Проверьте тип TVs and Limited Input devices, а также что клиент существует и включён.',
    setupBusy: '⏳ Другой администратор подключает Drive. Повторно отправьте этот документ позже; начинать настройку заново не нужно.',
    setupExpired: '⌛ Время настройки Drive истекло. Нажмите «Подключить Drive» и начните заново.',
    policyBlocked: '❌ Политика Google заблокировала доступ. Проверьте External/Internal, членство аккаунта в организации для Internal и политику администратора Workspace.',
    rateLimited: '⏳ Google ограничил частоту настройки. Подождите перед новой попыткой.',
    temporaryUnavailable: '❌ Google Drive или сеть временно недоступны. Повторите позже; предыдущее подключение не изменено.',
    providerResponse: '❌ Google вернул неожиданный ответ. Обновите или перезапустите Home Worker и повторите; JSON не обязательно ошибочен.',
    manualDelete: '⚠️ Не удалось удалить документ с данными. Удалите его вручную.',
    connected: '✅ Google Drive подключён.',
    connectionFailed: '❌ Не удалось завершить подключение Google Drive. Предыдущее подключение сохранено.',
    disconnectPrompt: 'Отключить Google Drive? Существующие архивные файлы не будут удалены.',
    disconnectConfirm: 'Отключить',
    disconnected: 'Google Drive отключён. Существующие архивы сохранены.',
    notConnected: 'Google Drive не подключён.',
    authorizationReady: (account: string) => `Авторизация Google завершена для ${account}. Вернитесь к сообщению с подтверждением, чтобы закончить подключение.`,
    authorizationPending: 'Авторизация Google ещё выполняется. Завершите её в браузере и попробуйте снова.',
    authorizationFailed: 'Авторизация Google не завершена. Предыдущее подключение сохранено.',
    accountUnavailable: 'выбранного аккаунта Google',
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
    invalidLiveSources: 'Метаданные источников видео неверны или содержат неподдерживаемые поля.',
    summary: (s: ImportSummary & { liveSources?: string[] }): string => {
      const lines = ['📋 Итоги импорта:', ''];
      lines.push(
        s.added.length > 0 ? `➕ Добавить: ${s.added.join(', ')}` : '➕ Добавить: нет',
      );
      lines.push(
        s.liveSources?.length
          ? `📷 Настроить источники видео: ${s.liveSources.join(', ')}`
          : '📷 Настроить источники видео: нет',
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
    applied: (s: ImportSummary & { liveSources?: string[] }): string =>
      `✅ Конфигурация импортирована. Добавлено: ${s.added.length}, обновлено: ${s.updated.length}, архивировано: ${s.archived.length}, источников видео без учётных данных: ${s.liveSources?.length ?? 0}.`,
    applyFailed: '❌ Импорт завершился ошибкой до применения изменений.',
    partialFailed: '⚠️ Метаданные источников видео применены; импорт датчиков завершился некорректно, и его изменения базы данных также могли быть применены. Проверьте текущую конфигурацию перед повтором.',
    sensorOutcomeUncertain: '⚠️ Импорт датчиков завершился некорректно, и изменения базы данных могли быть применены. Проверьте текущую конфигурацию перед повтором.',
    partialRoleChanged: '⚠️ Метаданные источников видео применены, но импорт датчиков остановлен из-за изменения прав администратора.',
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
      if (!v.archiveRecovered) {
        lines.push('⚠️ Не удалось восстановить работу архива — загрузка видео и резервные копии приостановлены до следующего перезапуска.');
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

export interface ConfigDisplay {
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  debounceMs: number;
  severity: SensorSeverity;
}

function formatAgeMs(value: number | null): string {
  if (value === null) return presentation.date.never;
  if (value < 60_000) return `${Math.floor(value / 1_000)} с`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)} мин`;
  if (value < 86_400_000) return `${Math.floor(value / 3_600_000)} ч`;
  return `${Math.floor(value / 86_400_000)} д`;
}
