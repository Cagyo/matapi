import { format } from 'date-fns';
import type { DbRecovery } from '../database/integrity';
import type { SensorSeverity, SensorType } from '../sensors/domain/sensor';
import type { ImportSummary } from '../sensors/application/import-sensors.use-case';
import type { FeatureStatus } from '../features/domain/feature-status';
import type { DepUpdate } from '../system/domain/ports/system-deps.port';
import type { User } from '../telegram/domain/user.entity';
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
    never: 'ніколи',
    unavailableTime: '—',
    age: {
      underMinute: ' (менше хвилини тому)',
      minutes: (minutes: number) => ` (${minutes} хв тому)`,
      hours: (hours: number) => ` (${hours} год тому)`,
      days: (days: number) => ` (${days} дн тому)`,
    },
  },
  fallback: {
    unavailable: 'н/д',
    unknown: 'невідомо',
    digitalOpen: 'ВІДЧИНЕНО',
    digitalOpened: 'ВІДЧИНЕНО',
    digitalClosed: 'ЗАЧИНЕНО',
  },
  config: {
    sensorTypes: {
      digital: 'Цифровий',
      uart: 'UART',
      mqtt: 'MQTT',
      camera: 'Камера',
    },
    severities: {
      info: 'Інформація',
      warning: 'Попередження',
      critical: 'Критичний',
    },
    pulls: {
      up: 'Вгору',
      down: 'Вниз',
      none: 'Немає',
      default: 'Вгору',
    },
  },
  units: {
    gigabytes: 'GB',
    megabytes: 'MB',
    ppm: 'ppm',
    uptime: (days: number, hours: number, minutes: number) => `${days} д ${hours} год ${minutes} хв`,
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
  const steps = (uk.sensors?.steps as Record<string, Record<string, string>>)?.[stepType ?? 'contact'];
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
    description: 'Інтерактивна панель команд',
    usage: '/menu — інтерактивна панель команд',
    scope: 'user',
  },
  {
    command: 'status',
    description: 'Стан датчиків',
    usage: '/status — стан датчиків',
    scope: 'user',
  },
  {
    command: 'logs',
    description: 'Журнал датчика',
    usage: '/logs <датчик> [кількість] — журнал датчика',
    scope: 'user',
  },
  {
    command: 'mute',
    description: 'Вимкнути сповіщення датчика для себе',
    usage: '/mute <датчик> — вимкнути сповіщення датчика для себе',
    scope: 'user',
  },
  {
    command: 'unmute',
    description: 'Знову ввімкнути сповіщення датчика для себе',
    usage: '/unmute <датчик> — знову ввімкнути сповіщення датчика для себе',
    scope: 'user',
  },
  {
    command: 'quiet_hours',
    description: 'Приглушити інформаційні сповіщення',
    usage: '/quiet_hours HH:MM-HH:MM | off — приглушити інформаційні сповіщення',
    scope: 'user',
  },
  {
    command: 'camera',
    description: 'Камера та рух',
    usage: '/camera <snapshot|events|video|photo|status|live|stop_stream> — камера та рух',
    scope: 'user',
  },
  {
    command: 'ping',
    description: 'Перевірити відповідь бота',
    usage: '/ping — перевірити відповідь бота',
    scope: 'user',
  },
  {
    command: 'help',
    description: 'Доступні команди й довідка',
    usage: '/help — це повідомлення',
    scope: 'user',
  },
  {
    command: 'health',
    description: 'Стан системи',
    usage: '/health — стан системи',
    scope: 'admin',
  },
  {
    command: 'config',
    description: 'Керування датчиками',
    usage: '/config add|modify|remove — керування датчиками',
    scope: 'admin',
  },
  {
    command: 'cancel',
    description: 'Скасувати активний майстер налаштування',
    usage: '/cancel — скасувати активний майстер налаштування',
    scope: 'admin',
  },
  {
    command: 'export_config',
    description: 'Завантажити поточну конфігурацію у YAML',
    usage: '/export_config — завантажити поточну конфігурацію у YAML',
    scope: 'admin',
  },
  {
    command: 'import_config',
    description: 'Імпортувати датчики з YAML-файлу',
    usage: '/import_config — імпортувати датчики з YAML-файлу',
    scope: 'admin',
  },
  {
    command: 'invite',
    description: 'Створити одноразовий код запрошення',
    usage: '/invite — створити одноразовий код запрошення',
    scope: 'admin',
  },
  {
    command: 'promote',
    description: 'Призначити користувача адміністратором',
    usage: '/promote <користувач> — призначити користувача адміністратором',
    scope: 'admin',
  },
  {
    command: 'demote',
    description: 'Позбавити адміністратора прав',
    usage: '/demote <користувач> — позбавити адміністратора прав',
    scope: 'admin',
  },
  {
    command: 'feature',
    description: 'Керувати додатковими можливостями',
    usage: '/feature enable|disable|list — керувати додатковими можливостями',
    scope: 'admin',
  },
  {
    command: 'update',
    description: 'Завантажити й установити останню версію',
    usage: '/update — завантажити й установити останню версію',
    scope: 'admin',
  },
  {
    command: 'rollback',
    description: 'Повернутися до попередньої версії',
    usage: '/rollback — повернутися до попередньої версії',
    scope: 'admin',
  },
  {
    command: 'system_update',
    description: 'Оновити залежності ОС',
    usage: '/system_update — оновити залежності ОС (apt, rclone; основні оновлення Node виконуються вручну)',
    scope: 'admin',
  },
  {
    command: 'restart',
    description: 'Перезапустити застосунок',
    usage: '/restart — перезапустити застосунок',
    scope: 'admin',
  },
  {
    command: 'gdrive',
    description: 'Стан синхронізації з Google Drive',
    usage: '/gdrive status — стан синхронізації з Google Drive',
    scope: 'admin',
  },
  {
    command: 'gdrive_auth',
    description: 'Налаштувати автентифікацію Google Drive',
    usage: '/gdrive_auth — налаштувати або замінити облікові дані Google Drive',
    scope: 'admin',
  },
  {
    command: 'settings',
    description: 'Налаштування системи та поріг автоочищення',
    usage: '/settings — налаштування системи',
    scope: 'user',
  },
  {
    command: 'clean',
    description: 'Запустити очищення сховища вручну',
    usage: '/clean [threshold] — запустити очищення сховища вручну',
    scope: 'admin',
  },
  {
    command: 'claim_admin',
    description: 'Призначити себе адміністратором (лише під час першого запуску)',
    usage: '/claim_admin <токен> — призначити себе адміністратором (лише під час першого запуску)',
    scope: 'admin',
  },
];

const PINOUT_SCHEMA = `<pre>📌 Розводка GPIO Raspberry Pi (BCM)
[xx] = фізичний контакт | BCM = номер GPIO

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

const ukCatalog = {
  presentation,
  commands,
  sensors: {
    steps: {
      contact:     { false: 'Зачинено',       true: 'Відчинено',           offline: '❓ Не в мережі' },
      leak_hazard: { false: 'Сухо',           true: 'Виявлено протікання', offline: '❓ Не в мережі' },
      alarm:       { false: 'Норма',          true: 'Тривога',             offline: '❓ Не в мережі' },
      power:       { false: 'Мережа в нормі', true: 'Знеструмлення',       offline: '❓ Не в мережі' },
      motion:      { false: 'Немає руху',     true: 'Рух',                 offline: '❓ Не в мережі' },
      button:      { false: 'Відпущено',      true: 'Натиснуто',           offline: '❓ Не в мережі' },
    },
    notifications: {
      alarmTriggered: (name: string, state: string) => `🚨 *КРИТИЧНА ТРИВОГА:* ${name} тепер *${state}*!`,
      alarmResolved:  (name: string, state: string) => `✅ *ВІДНОВЛЕНО:* ${name} знову *${state}*.`,
      infoChange:     (name: string, state: string, oldState: string) => `ℹ️ *${name}:* ${state} (було ${oldState})`,
      flappingFault:  (name: string) => `⚠️ *НЕСПРАВНІСТЬ:* датчик *${name}* переведено на опитування через нестабільні спрацювання!`,
      viewLogs: '📋 Переглянути журнал',
      watchLive: '📺 Дивитися наживо',
      mqttOffline: '🔴 MQTT-брокер не в мережі',
      mqttRecovered: '🟢 MQTT-брокер знову підключено',
    },
  },
  common: {
    adminRequired: '❌ Потрібні права адміністратора',
    error: (action: string, reason: string) => `❌ Не вдалося ${action}: ${reason}`,
    failure: (reason: string) => `❌ Помилка: ${reason}`,
    historical: (value: string) => `Історичне значення: ${value}`,
    interrupted: 'Попередню операцію перервано. Почніть знову.',
    cancelButton: '❌ Скасувати',
    backButton: '« Назад',
    closeButton: '❌ Закрити',
    quietModeButton: '🌙 Тихий режим',
    noActiveWizard: 'ℹ️ Немає активного майстра налаштування для скасування.',
  },
  language: {
    prompt: 'Виберіть мову:',
    current: (language: string) => `Поточна мова: ${language}`,
    updated: (language: string) => `✅ Мову змінено: ${language}.`,
    updateFailed: 'Не вдалося змінити мову. Спробуйте ще раз.',
    retryLanguageChange: 'Повторити зміну мови',
    returnToMore: '« Більше',
    restoreMoreFailed: 'Мову змінено, але розділ «Більше» не вдалося відкрити.',
    buttons: {
      en: 'Англійська',
      ru: 'Російська',
      uk: 'Українська',
    },
  },
  claim: {
    success: '✅ Тепер ви адміністратор цього Home Worker.',
    alreadyClaimed: '❌ У цього Home Worker уже є адміністратор.',
    invalidToken: '❌ Недійсний токен призначення адміністратора. Використайте команду з майстра налаштування.',
    notConfigured: '❌ Призначення адміністратора вимкнено, доки не налаштовано CLAIM_ADMIN_TOKEN.',
  },
  users: {
    inviteIssued: (code: string) =>
      `🔗 Код запрошення: ${code}\nНадішліть його новому користувачеві. Йому слід надіслати:\n/start ${code}`,
    inviteFailed: '❌ Не вдалося створити код запрошення',
    startNoCode: 'Щоб зареєструватися, надішліть /start <код_запрошення>',
    invalidCode: '❌ Недійсний код запрошення',
    codeUsed: '❌ Цей код запрошення вже використано',
    alreadyRegistered: 'Ви вже зареєстровані',
    welcomed: (name: string) => `✅ Вітаємо, ${name}! Вас зареєстровано як користувача.`,
    joinedNotice: (name: string) => `👤 ${name} приєднався за вашим кодом запрошення.`,
    userNotFound: '❌ Користувача не знайдено',
    alreadyAdmin: (name: string) => `ℹ️ ${name} уже адміністратор`,
    alreadyUser: (name: string) => `ℹ️ ${name} уже звичайний користувач`,
    promoted: (name: string) => `✅ ${name} призначено адміністратором.`,
    promotedNotice: (admin: string) =>
      `🎉 ${admin} призначив вас адміністратором.`,
    demoted: (name: string) => `✅ ${name} позбавлено прав адміністратора.`,
    demotedNotice: (admin: string) => `${admin} позбавив вас прав адміністратора.`,
    finalAdmin: '❌ Неможливо позбавити прав останнього адміністратора.',
    promoteFailed: '❌ Не вдалося призначити користувача адміністратором',
    demoteFailed: '❌ Не вдалося позбавити користувача прав адміністратора',
    registerFailed: '❌ Не вдалося зареєструватися',
    missingTarget: (cmd: string) =>
      `❌ Використання: /${cmd} <ім’я|id:telegram_id>`,
    ambiguousTarget: (
      cmd: string,
      matches: readonly Pick<User, 'telegramId' | 'name'>[],
    ) =>
      `❌ Знайдено кількох користувачів. Повторіть /${cmd} з id:<telegram_id>: ${matches
        .map((match) => `${match.name} (id:${match.telegramId})`)
        .join(', ')}`,
  },
  home: {
    title: '🏠 Дім',
    verdicts: {
      attention: (count: number) => `⚠️ Уваги потребують датчики: ${count}`,
      unavailable: '⚠️ Моніторинг недоступний',
      normal: '✅ Усе гаразд',
    },
    state: {
      counts: (known: number, unknown: number) => `Стани: відомо ${known} · невідомо ${unknown}`,
      absent: 'Стани: показань датчиків ще немає',
    },
    health: {
      counts: (online: number, total: number) => `Датчики на зв’язку: ${online} з ${total}`,
      absent: 'Моніторинг: завершених перевірок ще не було',
      stale: 'Моніторинг: остання перевірка застаріла',
      checking: '⏳ Перевірка моніторингу…',
      failed: 'Моніторинг: остання перевірка завершилася помилкою',
    },
    buttons: {
      sensors: '📊 Датчики',
      camera: '📷 Камера',
      notifications: '🔔 Сповіщення',
      more: '⋯ Більше',
      checkNow: '↻ Перевірити',
    },
    notifications: {
      normal: 'Сповіщення: звичайний режим',
      quietHours: (until: string) => `Сповіщення: тихий режим до ${until}`,
      timedPause: (until: Date) => `Сповіщення: пауза до ${fmtTime(until)}`,
      legacyPause: 'Сповіщення: увімкнено застарілу паузу',
      pausedTargets: (count: number) => `Сповіщення: призупинено цілей: ${count}`,
      title: '🔔 Сповіщення',
      quietHoursSummary: (start: string | null, end: string | null) => start && end ? `Тихі години: ${start}–${end}` : 'Тихі години: вимкнено',
      legacyMutedSummary: 'Увімкнено застарілу паузу',
      mutedTargetsSummary: (count: number) => `Призупинено цілей: ${count}`,
      preset22To07: '22:00–07:00',
      preset23To06: '23:00–06:00',
      preset00To08: '00:00–08:00',
      presetOff: 'Вимкнути тихі години',
      targetSettings: '🎯 Налаштування цілей',
      pause: '⏸ Призупинити сповіщення',
      resume: '▶ Відновити сповіщення',
      undoQuietHours: '↩ Скасувати тихі години',
      targetsTitle: '🎯 Цілі сповіщень',
      targetsPage: (page: number, pageCount: number, total: number) => `Сторінка ${page} з ${pageCount} · цілей: ${total}`,
      targetsEmpty: 'Немає доступних цілей сповіщень.',
      targetTitle: '🎯 Ціль сповіщень',
      targetMuted: 'Сповіщення для цієї цілі призупинено',
      targetActive: 'Сповіщення для цієї цілі активні',
      mute: '🔇 Призупинити сповіщення',
      unmute: '🔊 Відновити сповіщення',
      pauseTitle: '⏸ Призупинити сповіщення',
      pausePrompt: 'Виберіть тривалість паузи для некритичних сповіщень:',
      pauseHours: (hours: number) => `${hours} год.`,
      pauseConfirmation: (hours: number) => `Призупинити некритичні сповіщення на ${hours} год.?`,
      confirmPause: 'Підтвердити паузу',
    },
    sensors: {
      title: '📊 Датчики',
      row: (name: string, state: string) => `• ${name}: ${state}`,
      page: (page: number, pageCount: number, total: number) => `Сторінка ${page} з ${pageCount} · датчиків: ${total}`,
      clamp: (page: number) => `Список змінився; показано сторінку ${page}.`,
      attention: (names: readonly string[]) => `Потребують уваги: ${names.join(' · ')}`,
      attentionShown: (shown: number, total: number) => `Показано ${shown} з ${total}`,
      emptyMember: 'Датчики не налаштовано. Попросіть адміністратора додати датчик.',
      emptyAdmin: 'Датчики не налаштовано.',
      setupSensors: '⚙️ Налаштувати датчики',
      previous: '‹ Назад',
      next: 'Далі ›',
      back: '« Назад',
      home: '🏠 Дім',
    },
    common: {
      back: '« Назад',
      home: '🏠 Дім',
    },
    workflow: {
      backTo: (destination: string) => `Назад до ${destination}`,
      cancel: (workflow: string) => `Скасувати ${workflow}`,
      home: 'Дім',
      workContinues: (work: string) => `${work} · робота триває`,
      unfinishedSetupExpired: 'Незавершене налаштування втратило чинність після перезапуску.',
      retryReturn: 'Повторити повернення',
      returnUnavailable: 'Повернення тимчасово недоступне.',
      outcomeNotice: (outcome: string) => outcome,
    },
    navigation: {
      backTo: {
        notifications: '« Сповіщення',
        'notification-targets': '« Налаштування цілей',
        'pause-duration': '« Сповіщення',
        history: '« Більше',
        more: '« Більше',
        'admin-tools': '« Інструменти адміністратора',
        'admin-storage': '« Сховище та резервні копії',
        'admin-system': '« Система',
      },
    },
    history: {
      title: '🗂 Історія',
      logs: '📜 Журнали',
      exportCsv: '⬇ Експорт CSV',
    },
    more: {
      title: '⋯ Більше',
      history: '🗂 Історія',
      settings: '⚙️ Мої налаштування',
      help: '❓ Довідка',
      adminTools: '🛠 Інструменти адміністратора',
    },
    adminTools: {
      title: '🛠 Інструменти адміністратора',
      sensorSetup: '⚙️ Налаштування датчиків',
      storage: '💾 Сховище та резервні копії',
      system: '🖥 Система',
      invite: '👤 Створити запрошення',
    },
    adminSensorSetup: {
      title: '⚙️ Налаштування датчиків',
      add: '➕ Додати',
      modify: '✏️ Змінити',
      remove: '🗑 Видалити',
      import: '⬆ Імпорт',
      export: '⬇ Експорт',
    },
    adminStorage: {
      title: '💾 Сховище та резервні копії',
      driveStatus: '☁️ Стан Drive',
      connectDrive: '🔗 Підключити Drive',
      cleanup: '🧹 Очистити сховище',
    },
    adminSystem: {
      title: '🖥 Система',
      health: '❤️ Стан',
      packages: '📦 Системні пакети',
      restart: '🔄 Перезапустити worker',
      cleanupThreshold: '🧹 Поріг очищення',
    },
    adminCleanupThreshold: {
      title: '🧹 Поріг очищення',
      threshold: (value: number, current: number) => `${value}%${value === current ? ' ✓' : ''}`,
    },
    confirmation: {
      cleanup: 'Очистити сховище?',
      restart: 'Перезапустити worker?',
      confirmCleanup: 'Підтвердити очищення',
      confirmRestart: 'Підтвердити перезапуск',
    },
    cleanupResult: {
      executed: (threshold: number | null) => threshold === null ? 'Очищення запущено.' : `Очищення запущено при ${threshold}%.`,
      inProgress: 'Очищення вже виконується.',
      failed: 'Не вдалося запустити очищення.',
    },
    recovery: {
      stale: 'Цей Дім більше не активний.',
      updating: 'Цей Дім оновлюється. Спробуйте за мить.',
      unavailable: 'Дім тимчасово недоступний. Скористайтеся прямою командою та повторіть спробу.',
      openNewHome: '🏠 Відкрити новий Дім',
      retryReturn: 'Повторити повернення',
      closed: 'Моніторинг Дому закрито.',
    },
    legacyNotifications: {
      title: '🔔 Сповіщення',
      muteSensors: '🔇 Вимкнути датчики',
      unmuteSensors: '🔊 Увімкнути датчики',
      quietHours: '🌙 Тихі години',
    },
  },
  feature: {
    usage: '❌ Використання: /feature enable|disable|list [назва_можливості]',
    listHeader: '🔧 Можливості',
    listLine(f: FeatureStatus): string {
      const icon = !f.installed ? '⬜' : f.enabled ? '✅' : '❌';
      const state = f.enabled ? 'увімкнено' : 'вимкнено';
      const install = f.installed ? 'установлено' : 'не встановлено';
      return `${icon} ${f.name} — ${state} (${install})`;
    },
    enabled: (name: string) =>
      `✅ Можливість '${name}' увімкнено.\nℹ️ Перезапустіть застосунок, щоб повністю її завантажити.`,
    disabled: (name: string) =>
      `✅ Можливість '${name}' вимкнено.\nℹ️ Перезапустіть застосунок, щоб повністю її вивантажити.`,
    unknown: (name: string) =>
      `❌ Невідома можливість '${name}'. Скористайтеся /feature list.`,
    notInstalled: (name: string) =>
      `❌ Для можливості '${name}' потрібні системні залежності. Повторно запустіть скрипт встановлення з увімкненою ${name}.`,
    alreadyEnabled: (name: string) => `ℹ️ Можливість '${name}' уже ввімкнено`,
    alreadyDisabled: (name: string) =>
      `ℹ️ Можливість '${name}' уже вимкнено`,
    enableFailed: '❌ Не вдалося ввімкнути можливість',
    disableFailed: '❌ Не вдалося вимкнути можливість',
    listFailed: '❌ Не вдалося отримати перелік можливостей',
  },
  setupWizard: {
    featureDescriptions: {
      rtsp: 'Експериментальна пряма MJPEG-трансляція Motion',
    },
  },
  status: {
    header: '📊 Стан системи',
    none: 'Датчики не налаштовано. Додайте їх командою /config.',
    line(row: StatusRow): string {
      const icon = TYPE_ICONS[row.type] ?? '•';
      let value = fmtRowValue(row);
      if (!row.online) {
        const offlineStep = (uk.sensors?.steps as Record<string, Record<string, string>>)?.[row.stepType ?? 'contact']?.offline;
        value = offlineStep ?? '❓ Не в мережі';
      }
      const ago = fmtAgo(row.lastValueAt);
      let suffix = '';
      if (!row.online) {
        suffix = ` ⚠️ не в мережі${ago}`;
      } else if (
        row.type === 'digital' &&
        (row.lastValue === 'true' || row.lastValue === '1') &&
        row.lastValueAt
      ) {
        suffix = ` ⚠️ (з ${fmtTime(row.lastValueAt)}${ago})`;
      } else if (ago) {
        suffix = ago;
      }
      return `${icon} ${row.name}: ${value}${suffix}`;
    },
    footer(allOnline: boolean, offlineCount: number, now: Date): string {
      const head = allOnline
        ? '📡 Усі системи в мережі'
        : `⚠️ ${offlineCount} ${plural(offlineCount, 'датчик не в мережі', 'датчики не в мережі', 'датчиків не в мережі')}`;
      return `${head} | ${fmtDate(now)}`;
    },
    readFailed: '❌ Не вдалося прочитати стан датчиків',
  },
  ping: {
    pong: (ms: number) => `🏓 Понг! (${ms}ms)`,
  },
  health: {
    header: '🏥 Стан системи',
    body(snap: HealthSnapshotView): string {
      const lines = [
        `💾 Диск: ${gb(snap.diskUsedBytes)} / ${gb(snap.diskTotalBytes)} (${percent(
          snap.diskUsedBytes,
          snap.diskTotalBytes,
        )})`,
        `🌡️ Температура CPU: ${snap.cpuTempC !== null ? `${Math.round(snap.cpuTempC)}°C` : 'н/д'}`,
        `🧠 Пам’ять: ${mb(snap.memoryUsedBytes)} / ${mb(snap.memoryTotalBytes)} (${percent(
          snap.memoryUsedBytes,
          snap.memoryTotalBytes,
        )})`,
        `⏱️ Час роботи: ${fmtUptime(snap.uptimeSec)}`,
        `📊 Розмір БД: ${mb(snap.dbSizeBytes)}`,
        `📡 Бот: ${
          snap.botLastUpdateAgoSec === null
            ? 'бездіяльний'
            : `опитування працює (останнє оновлення ${snap.botLastUpdateAgoSec} с тому)`
        }`,
        `🔌 Датчики: ${snap.sensorsOnline}/${snap.sensorsTotal} у мережі`,
      ];
      return lines.join('\n');
    },
    collectFailed: '❌ Не вдалося зібрати дані про стан системи',
  },
  logs: {
    header(name: string, count: number): string {
      return `📋 Журнал ${name} (останні ${count}):`;
    },
    none(name: string): string {
      return `Для датчика '${name}' записів немає`;
    },
    line(entry: LogLineView): string {
      return `${fmtDate(entry.timestamp, true)} [${entry.level.toUpperCase()}] ${entry.message}`;
    },
    stateChange(stepType: string, oldVal: boolean, newVal: boolean): string {
      const steps = (uk.sensors?.steps as Record<string, Record<string, string>>)?.[stepType] || uk.sensors.steps.contact;
      const oldStr = (oldVal ? steps.true : steps.false).toUpperCase();
      const newStr = (newVal ? steps.true : steps.false).toUpperCase();
      return `Стан змінено: ${oldStr} → ${newStr}`;
    },
    debounceTriggered(count: number, windowSec: number): string {
      return `Спрацював антидребезг (${count} ${plural(count, 'подія', 'події', 'подій')} за ${windowSec} с)`;
    },
    flappingFault(name: string, pin: number): string {
      return `Датчик "${name}" (контакт ${pin}) нестабільно спрацьовує! Перехід у режим опитування раз на 10 с.`;
    },
    fileName(name: string): string {
      return `logs_${name}_${format(new Date(), 'yyyy-MM-dd')}.txt`;
    },
    notFound: (name: string) => `❌ Датчик '${name}' не знайдено`,
    invalidDuration: '❌ Неправильний формат тривалості. Використовуйте: 30m, 2h, 1d, 7d',
    invalidCount: '❌ Неправильна кількість. Введіть додатне число.',
    selectSensor: '📋 Виберіть датчик, щоб переглянути останні записи:',
    readFailed: '❌ Не вдалося прочитати журнал',
  },
  csv: {
    selectTarget: '📄 Виберіть історію датчика для експорту:',
    empty: 'Немає доступних історій датчиків для експорту.',
    invalidCount: '❌ Неправильна кількість рядків CSV. Введіть ціле число від 1 до 5000.',
    invalidSelection: '❌ Вибрана історія CSV більше недоступна. Виберіть ще раз.',
    notFound: '❌ Вибрану історію датчика не знайдено.',
    noRows: 'ℹ️ Вибраний датчик не має рядків історії для експорту.',
    rowTooLarge: '❌ Вибраний рядок історії завеликий для експорту.',
    fileTooLarge: '❌ CSV-файл завеликий для експорту.',
    malformedTimestamp: '❌ Вибраний рядок історії має некоректну мітку часу.',
    staging: '⏳ Експорт CSV готується. Ви можете повернутися на головну, не скасовуючи його.',
    inProgress: '⏳ Експорт CSV із цього списку вже виконується.',
    failed: '❌ Не вдалося експортувати CSV.',
    caption: '📄 Експорт історії датчика у CSV.',
    previousPage: '‹ Назад',
    nextPage: 'Далі ›',
    disabledTarget: (name: string) => `⏸️ ${name} (вимкнено)`,
    archivedTarget: (name: string) => `🗄️ ${name} (архівовано)`,
  },
  help: {
    user: [
      '📖 Доступні команди',
      '',
      ...commands.filter((c) => c.scope === 'user').map((c) => c.usage),
    ].join('\n'),
    admin: [
      '📖 Доступні команди',
      '',
      ...commands.filter((c) => c.scope === 'user').map((c) => c.usage),
      '',
      '🔧 Команди адміністратора',
      '',
      ...commands.filter((c) => c.scope === 'admin').map((c) => c.usage),
    ].join('\n'),
  },
  menu: {
    title: '🎛️ Інтерактивна панель команд\nВиберіть категорію або команду нижче:',
    closed: 'Панель закрито.',
    categories: {
      sensors: '📊 Стан і датчики',
      media: '📷 Камера й медіа',
      admin: '⚙️ Адміністрування й налаштування',
      lifecycle: '🔄 Життєвий цикл і обслуговування',
    },
    buttons: {
      status: '📊 Стан',
      health: '🏥 Стан системи',
      logs: '📋 Журнал',
      exportCsv: '📄 Експорт CSV',
      mute: '🔇 Вимкнути сповіщення',
      cameraStatus: '📷 Стан камери',
      gdrive: '☁️ Синхронізація Drive',
      config: '⚙️ Налаштування',
      settings: '⚙️ Параметри',
      clean: '🧹 Запустити очищення',
      invite: '🔗 Запросити',
      feature: '🔧 Можливості',
      update: '⬆️ Оновити',
      restart: '🔄 Перезапустити',
      exportConfig: '📤 Експортувати конфігурацію',
    },
    submenus: {
      configTitle: '⚙️ *Налаштування датчиків*\n\nВиберіть дію:',
      configAdd: '➕ Додати датчик',
      configModify: '✏️ Змінити датчик',
      configRemove: '🗑️ Видалити датчик',
      featuresTitle: '🔧 *Керування можливостями*\n\nВиберіть можливість, щоб увімкнути, вимкнути або переглянути її:',
      featuresList: '📋 Усі можливості',
      restartConfirmTitle: '⚠️ *Підтвердіть перезапуск системи*\n\nСправді перезапустити службу застосунку?',
      updateConfirmTitle: '⬆️ *Підтвердіть оновлення системи*\n\nПеревірити й установити останні оновлення коду?',
      confirmYes: '⚠️ Так, продовжити',
      confirmNo: '❌ Скасувати',
      sensorsTitle: '📊 *Дії з датчиками*\n\nВиберіть дію:',
      sensorsMute: '🔇 Вимкнути сповіщення датчика',
      sensorsUnmute: '🔊 Увімкнути сповіщення датчика',
      sensorsMuteAll: '🔇 Вимкнути всі',
      sensorsUnmuteAll: '🔊 Увімкнути всі',
      sensorsExportCsv: '📄 Експорт CSV',
      systemTitle: '🔄 *Система й обслуговування*\n\nВиберіть дію:',
      systemUpdate: '⬆️ Перевірити оновлення',
      systemRestart: '🔄 Перезапустити застосунок',
      systemHealth: '🏥 Стан системи',
      systemDrive: '☁️ Стан синхронізації Drive',
      systemSettings: '⚙️ Параметри системи',
      systemClean: '🧹 Запустити очищення зараз',
      systemInvite: '🔗 Створити код запрошення',
      backToMenu: '« Назад',
      quietTitle: '🌙 *Тихий режим (розклад)*\n\nВиберіть готовий розклад тихих годин:',
      quiet22_07: '🌙 22:00 - 07:00 (10h)',
      quiet23_06: '🌙 23:00 - 06:00 (8h)',
      quiet00_08: '🌙 00:00 - 08:00 (8h)',
      quietDisable: '🔔 Вимкнути тихий режим',
    },
    quietMode: {
      title: '🌙 *Тихий режим*\n\nВиберіть тривалість вимкнення інформаційних сповіщень:',
      h1: '1 година',
      h4: '4 години',
      h8: '8 годин',
      off: '🔔 Увімкнути всі (звичайний режим)',
      activated: (hours: number) => `🌙 *Тихий режим увімкнено*\nІнформаційні сповіщення вимкнено на ${hours} ${plural(hours, 'годину', 'години', 'годин')}. Критичні тривоги доставлятимуться.`,
      deactivated: '🔔 *Тихий режим вимкнено*\nЗвичайні сповіщення відновлено.',
    },
    usage: {
      logs: 'Використання: /logs <датчик> [кількість] — наприклад /logs front_door 20',
      mute: 'Використання: /mute <датчик> — наприклад /mute front_door',
      config: 'Використання: /config add|modify|remove — керування датчиками',
      feature: 'Використання: /feature list|enable|disable [назва] — керування додатковими можливостями',
      update: 'Щоб оновити застосунок до останньої версії, надішліть /update',
      restart: 'Щоб перезапустити застосунок, надішліть /restart',
    },
  },
  config: {
    selectModify: '✏️ *Виберіть датчик для зміни*\n\nВиберіть активний датчик, щоб змінити його налаштування:',
    selectRemove: '🗑️ *Виберіть датчик для видалення*\n\nВиберіть активний датчик, який слід видалити:',
    noActiveSensors: 'ℹ️ Активних датчиків не налаштовано.',
    cancelSensorSetup: 'Скасувати налаштування датчиків',
    step1: 'Крок 1 із 5 — який тип датчика?',
    step2: (type: string) => `Крок 2 із 5 (${type})\n\nНазва датчика?`,
    step3Digital: (name: string, usedPins?: string) =>
      `Крок 3 із 5 (цифровий: "${name}")\n\nВиберіть доступний контакт GPIO.\n\n${PINOUT_SCHEMA}${
        usedPins ? `\n\nУже використано: ${usedPins}` : ''
      }`,
    step4Digital: (name: string, pin: number) => `Крок 4 із 5 (цифровий: "${name}", контакт ${pin})\n\nВиберіть тип стану (клас пристрою):`,
    step5Digital: (name: string, pin: number, stepType: string) => `Крок 5 із 5 (цифровий: "${name}", контакт ${pin}, ${stepType})\n\nРівень важливості?\n💡 _Підказка: інформація = тихий запис у журналі; попередження = звичайне сповіщення; критичний = термінова тривога._`,
    step3Uart: (name: string) => `Крок 3 із 5 (UART: "${name}")\n\nШлях до послідовного порту? (наприклад /dev/serial0)`,
    step4Uart: (name: string, port: string) => `Крок 4 із 5 (UART: "${name}", порт ${port})\n\nШвидкість передавання?\n💡 _Підказка: швидкість зв’язку в біт/с. 9600 — стандарт для більшості датчиків CO2._`,
    step5Uart: (name: string, port: string, baud: number) => `Крок 5 із 5 (UART: "${name}", порт ${port}, ${baud} бод)\n\nПоріг попередження (ppm)?\n💡 _Підказка: рівень CO2 у ppm, що викликає попередження (наприклад, 1000)._`,
    typeQuestion: 'Який тип датчика?',
    nameQuestion: 'Назва датчика?',
    pinQuestion: (usedPins?: string) =>
      `Номер контакту GPIO (0–27)?\n\n${PINOUT_SCHEMA}${
        usedPins ? `\n\nУже використано: ${usedPins}` : ''
      }`,
    gpioPickerOnly: 'Виберіть одну з доступних кнопок GPIO нижче.',
    noAvailableGpioPins: '❌ Немає доступних контактів GPIO. Видаліть або переналаштуйте цифровий датчик і повторіть спробу.',
    stepTypeQuestion: 'Виберіть тип стану (клас пристрою):',
    activeQuestion: 'Активний високий чи низький рівень?',
    pullQuestion: 'Підтягувальний резистор?',
    severityQuestion: 'Рівень важливості?',
    portQuestion: 'Шлях до послідовного порту?',
    baudQuestion: 'Швидкість передавання?',
    warningQuestion: 'Поріг попередження (ppm)?',
    criticalQuestion: 'Критичний поріг (ppm)?\n💡 _Підказка: терміновий рівень CO2 (має бути вищим за попередження, наприклад 1500)._',
    debouncePrompt: 'Антидребезг (мс)?\n💡 _Підказка: час у мілісекундах для ігнорування брязкоту кнопки або швидких перемикань (наприклад, 10000 = 10 с)._',
    defaultButton: '⚡ Використати типові значення (контакт, інформація)',
    invertToggleSuccess: (name: string, newState: string) => `✅ Логічний стан датчика "${name}" інвертовано. Поточний стан: ${newState}`,
    removeConfirm: (name: string) =>
      `Видалити датчик "${name}"? Його буде архівовано.`,
    removed: (name: string) => `✅ Датчик "${name}" архівовано.`,
    cancelled: 'Скасовано.',
    addedDigital: (
      name: string,
      pin: number,
      stepType: string,
      severity: SensorSeverity,
    ) =>
      `✅ Датчик "${name}" додано (GPIO ${pin}, ${stepType}, ${presentation.config.severities[severity]})`,
    addedUart: (
      name: string,
      port: string,
      baud: number,
      warning: number,
      critical: number,
    ) =>
      `✅ Датчик "${name}" додано (UART ${port}, ${baud} бод, попер.: ${warning}, крит.: ${critical})`,
    modifyHeader: (sensor: ConfigDisplay) => {
      const lines = [
        `Поточна конфігурація "${sensor.name}":`,
        `Тип: ${presentation.config.sensorTypes[sensor.type]}`,
      ];
      if (sensor.type === 'digital') {
        const inv = sensor.config.invert ?? sensor.config.activeLow ?? true;
        const pull = sensor.config.pull as string | undefined;
        lines.push(
          `GPIO: ${(sensor.config.pin as number | undefined) ?? '?'}`,
          `Тип стану: ${(sensor.config.stepType as string | undefined) ?? 'contact'}`,
          `Активний низький рівень: ${inv === false ? 'Ні' : 'Так'} — спрацьовує, коли сигнал ${inv === false ? 'високий' : 'низький'}`,
          `Підтягування: ${presentation.config.pulls[pull as keyof typeof presentation.config.pulls] ?? presentation.config.pulls.default} — ${pull === 'none' ? 'немає внутрішнього резистора; використайте зовнішнє підключення для стабілізації входу' : 'забезпечує стабільність входу, коли його не підключено'}`,
        );
      } else if (sensor.type === 'uart') {
        lines.push(
          `Порт: ${(sensor.config.port as string | undefined) ?? '?'}`,
          `Швидкість: ${(sensor.config.baudRate as number | undefined) ?? '?'}`,
          `Попередження: ${(sensor.config.thresholds as { warning?: number } | undefined)?.warning ?? '?'} ppm`,
          `Критичний: ${(sensor.config.thresholds as { critical?: number } | undefined)?.critical ?? '?'} ppm`,
        );
      }
      lines.push(
        `Антидребезг: ${sensor.debounceMs}ms — короткочасно ігнорує повторні сигнали`,
        `Важливість: ${presentation.config.severities[sensor.severity]}`,
        '',
        'Що змінити?',
      );
      return lines.join('\n');
    },
    modifyMenuPrompt: 'Що змінити?',
    modifiedField: (field: string) => `✅ ${field} оновлено. Ще щось?`,
    modifyDone: (name: string) => `✅ Датчик "${name}" оновлено.`,
    nameTaken: (name: string) => `❌ Датчик '${name}' уже існує`,
    notFound: (name: string) => `❌ Датчик '${name}' не знайдено`,
    pinTaken: (pin: number, owner: string) =>
      `❌ GPIO ${pin} уже використовується датчиком '${owner}'`,
    invalidPin: '❌ Номер контакту GPIO має бути від 0 до 27',
    invalidName:
      '❌ Неправильна назва датчика. Використовуйте лише літери, цифри та підкреслення.',
    invalidNumber: '❌ Введіть правильне число.',
    invalidPinRange: '❌ Неправильний номер контакту GPIO. Введіть число від 0 до 27:',
    invalidThresholdOrder: (warn: number) =>
      `❌ Критичний поріг має бути вищим за поріг попередження (${warn} ppm). Введіть критичний поріг > ${warn}:`,
    invalidPortPath:
      '❌ Шлях до послідовного порту має бути непорожнім рядком (наприклад /dev/ttyUSB0):',
    invalidDebounce:
      '❌ Введіть час антидребезгу в мілісекундах (0 або більше):',
    invalidPort: '❌ Шлях до послідовного порту має бути непорожнім рядком.',
    thresholdsOrder: '❌ Поріг попередження має бути нижчим за критичний.',
    missingArg: (cmd: string) => `❌ Використання: /config ${cmd} <назва_датчика>`,
    addStarted: 'Запущено /config add — дайте відповіді нижче.',
  },
  mute: {
    missingSensor: '❌ Використання: /mute <назва_датчика>',
    missingSensorUnmute: '❌ Використання: /unmute <назва_датчика>',
    selectMute: '🔇 Виберіть датчик, для якого вимкнути сповіщення:',
    selectUnmute: '🔔 Виберіть датчик, для якого ввімкнути сповіщення:',
    notFound: (name: string) => `❌ Датчик '${name}' не знайдено`,
    muted: (name: string) => `🔇 Сповіщення для ${name} вимкнено.`,
    alreadyMuted: (name: string) => `ℹ️ Для ${name} сповіщення вже вимкнено`,
    unmuted: (name: string) => `🔔 Сповіщення для ${name} ввімкнено.`,
    notMuted: (name: string) => `ℹ️ Для ${name} сповіщення не вимкнено`,
    muteFailed: '❌ Не вдалося вимкнути сповіщення датчика',
    unmuteFailed: '❌ Не вдалося ввімкнути сповіщення датчика',
    mutedAll: (count: number) => `🔇 Сповіщення вимкнено для ${count} ${plural(count, 'датчика', 'датчиків', 'датчиків')}.`,
    unmutedAll: (count: number) => `🔔 Сповіщення ввімкнено для ${count} ${plural(count, 'датчика', 'датчиків', 'датчиків')}.`,
    noSensorsToMute: 'ℹ️ Для всіх доступних датчиків сповіщення вже вимкнено або датчиків немає.',
    noSensorsToUnmute: 'ℹ️ Усі доступні датчики вже активні або датчиків немає.',
  },
  quietHours: {
    invalidFormat:
      '❌ Використовуйте формат: /quiet_hours HH:MM-HH:MM (наприклад, 23:00-07:00)',
    invalidTime: '❌ Неправильний час. Використовуйте 24-годинний формат (00:00-23:59)',
    set: (start: string, end: string) =>
      `🌙 Тихі години встановлено: ${start} — ${end}\nІнформаційні сповіщення вимкнено. Критичні тривоги надходитимуть і далі.`,
    disabled: '☀️ Тихі години вимкнено.',
    setFailed: '❌ Не вдалося встановити тихі години',
  },
  ota: {
    checking: '🔄 Перевірка оновлень...',
    upToDate: 'ℹ️ Установлено останню версію.',
    updating: (commit: string) =>
      `🔄 Оновлення до ${commit}... Я ненадовго буду не в мережі та повідомлю, коли все буде готово.`,
    inProgress: '⏳ Оновлення вже виконується, зачекайте.',
    fetchFailed: (reason: string) => `❌ Не вдалося перевірити оновлення: ${reason}`,
    updateSuccess: (commit: string) =>
      `✅ Оновлення завершено.\nКоміт: ${commit}`,
    updateFailed: '❌ Оновлення не вдалося, повернуто попередню версію.',
    rollbackStarting: '⏪ Повернення до попередньої версії...',
    rollbackNoTag: '❌ Немає попередньої версії, до якої можна повернутися.',
    rollbackSuccess: (commit: string) => `✅ Повернуто версію з коміту ${commit}.`,
    rollbackFailed: (reason: string) =>
      `❌ Не вдалося повернути попередню версію: ${reason}. Може знадобитися доступ через SSH.`,
    restarting: '🔄 Перезапуск...',
    restartComplete: '✅ Перезапуск завершено. Час роботи скинуто.',
    restartFailed: (reason: string) => `❌ Не вдалося перезапустити: ${reason}`,
  },

  systemUpdate: {
    checking: '🔄 Перевірка системних залежностей...',
    allUpToDate: '✅ Усі системні залежності оновлено.',
    header: '🔄 Доступне системне оновлення:',
    depLine: (d: DepUpdate): string => {
      switch (d.kind) {
        case 'upgrade':
          return `• ${d.name}: ${d.current} → ${d.available}`;
        case 'node-minor':
          return `• ${d.name}: ${d.current} → ${d.available} (мінорне)`;
        case 'node-major':
          return `• ${d.name}: ${d.current} → ${d.available} (мажорне — вручну)`;
        case 'not-installed':
          return `• ${d.name}: не встановлено`;
        case 'unknown':
          return `• ${d.name}: версію не визначено`;
        case 'none':
        default:
          return `• ${d.name}: оновлень немає`;
      }
    },
    nodeMajorWarning: (current: string, desired: string) =>
      `⚠️ Виявлено мажорну зміну версії Node.js (${current} → ${desired}). Потрібне ручне втручання.`,
    applyButton: 'Застосувати',
    cancelButton: '❌ Скасувати',
    applying:
      '🔄 Застосування системного оновлення... Я перевірю стан системи та повідомлю, коли все буде готово.',
    completed: '✅ Системне оновлення завершено.',
    failed: '⚠️ Системне оновлення не пройшло перевірку стану. Перевірте через SSH.',
    cancelled: 'Системне оновлення скасовано.',
    checkFailed: (reason: string) =>
      `❌ Не вдалося перевірити оновлення: ${reason}`,
  },

  camera: {
    usage:
      'Використання: /camera <snapshot|events [DD.MM.YYYY]|video <id>|photo <id>|enable|disable|status|live [камера]|stop_stream>',
    dashboardTitle: '📹 Панель камери\nВиберіть дію:',
    dashboardButtons: {
      live: '🔴 Наживо',
      snapshot: '📸 Зробити знімок',
      browseEvents: '📹 Переглянути події',
      eventsToday: '📹 Сьогоднішні події',
      status: '⚙️ Стан',
      close: '❌ Закрити',
    },
    eventButtons: {
      video: (id: number) => `📹 Відео №${id}`,
      photo: (id: number) => `📸 Фото №${id}`,
    },
    browse: {
      menuTitle:
        '📹 Перегляд подій руху\nВиберіть режим пошуку.\n\nДля «Сьогодні», «Учора» та «Вибрати дату» далі потрібно вказати діапазон часу.',
      buttons: {
        today: 'Сьогодні',
        yesterday: 'Учора',
        pickDate: 'Вибрати дату',
        latest: 'Останні 20',
        back: '« Назад',
        close: '❌ Закрити',
        cancel: '❌ Скасувати',
        video: 'Відео',
        photo: 'Фото',
        backToResults: '« Назад',
      },
      datePrompt:
        'Надішліть дату для пошуку.\n\nФормат: DD.MM.YYYY\nПриклад: 08.04.2026',
      timeRangePrompt: (label: string) =>
        `Надішліть діапазон часу для ${label}.\n\nФормат: HH:MM-HH:MM\nПриклад: 18:00-23:00`,
      invalidDate: 'Дата має бути у форматі DD.MM.YYYY.\nПриклад: 08.04.2026',
      invalidTimeRange:
        'Діапазон часу має бути у форматі HH:MM-HH:MM.\nПриклад: 18:00-23:00',
      invalidTimeOrder:
        'Час завершення має бути пізнішим за час початку.\nДіапазони через північ поки не підтримуються.',
      cancelled: 'Перегляд подій скасовано.',
      expiredInput:
        'Термін дії цього пошуку минув. Відкрийте «Переглянути події», щоб почати знову.',
      resultsExpired: 'Термін дії цього списку результатів минув. Почніть новий пошук.',
      rangeHeader: (
        dateLabel: string,
        rangeLabel: string,
        count: number,
        hasMore: boolean,
      ) =>
        hasMore
          ? `📹 Події за ${dateLabel}, ${rangeLabel}\nСпочатку нові. Показано 20 найновіших збігів.\nЗвузьте діапазон часу, якщо події немає.`
          : `📹 Події за ${dateLabel}, ${rangeLabel}\nСпочатку нові. Показано ${count} ${plural(count, 'подію', 'події', 'подій')}.`,
      latestHeader: (count: number) =>
        `📹 Останні події руху\nСпочатку нові. Показано ${count} ${plural(count, 'подію', 'події', 'подій')}.`,
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
        if (!endedAt) return 'запис';
        return durationSec === null
          ? presentation.fallback.unknown
          : presentation.units.durationSeconds(durationSec);
      },
      media: (media: BrowseEventMediaView): string => {
        if (media.hasLocalVideo && media.hasPhoto) return 'Відео + фото';
        if (media.hasLocalVideo) return 'Відео';
        if (media.hasDriveVideo) {
          return media.hasPhoto ? 'Відео + фото' : 'Відео архівовано на Drive';
        }
        if (media.hasPhoto) return 'Фото';
        return 'Ще не готово';
      },
      emptyRange: (dateLabel: string, rangeLabel: string) =>
        `За ${dateLabel}, ${rangeLabel} подій руху не знайдено.\nСпробуйте ширший діапазон часу.`,
      emptyLatest: 'Подій руху ще не записано.',
      actionHeader: (event: BrowseEventActionView) =>
        [
          `📹 Подія №${event.id}`,
          `Початок: ${fmtDate(event.startedAt, true)}`,
          `Камера: ${event.camera}`,
          `Тривалість: ${event.duration}`,
          `Медіа: ${event.media}`,
        ].join('\n'),
      videoUnavailable: (id: number) =>
        `Відео для події №${id} більше недоступне.`,
    },
    closed: '📹 Панель камери закрито.',
    snapshotCaption: (name: string, at: Date) => `📸 ${name} | ${fmtDate(at)}`,
    eventsHeader: (day: Date) => `📹 Події руху за ${format(day, presentation.date.eventDayFormat)}:`,
    eventLine: (e: MotionEventView): string => {
      const time = e.startedAt
        ? format(e.startedAt, presentation.date.eventTimeFormat)
        : presentation.date.eventUnavailableTime;
      const dur = e.durationSec !== null ? presentation.units.eventDurationSeconds(e.durationSec) : '';
      const snap = e.hasSnapshot ? ' 📷' : '';
      return `#${e.id} — ${time}${dur}${snap}`;
    },
    eventsFooter: (count: number) =>
      `${count} ${plural(count, 'подія', 'події', 'подій')}. Використовуйте /camera video <id> або /camera photo <id>`,
    eventsNone: (day: Date) => `За ${format(day, presentation.date.eventDayFormat)} подій руху немає`,
    videoCaption: (id: number, at: Date | null, cam: string) =>
      `📹 Подія №${id} | ${fmtDate(at, true)} | ${cam}`,
    photoCaption: (id: number, at: Date | null, cam: string) =>
      `📸 Подія №${id} | ${fmtDate(at, true)} | ${cam}`,
    driveLinkFallback: (id: number, remotePath: string | null) =>
      remotePath
        ? `📹 Подія №${id} завелика для Telegram.\nЇї заархівовано на Google Drive:\n${remotePath}`
        : `📹 Подія №${id} завелика для Telegram і ще не має копії на Drive.`,
    statusHeader: '📹 Стан камери',
    statusBody: (v: CameraStatusView): string =>
      [
        `Рух: ${v.running ? '✅ Працює' : '❌ Зупинено'}`,
        `Остання подія: ${fmtDate(v.lastEventAt)}`,
        `Локальне сховище: ${mb(v.localStorageBytes)}`,
        `Подій сьогодні: ${v.eventsToday}`,
      ].join('\n'),
    motionStarted: '✅ Службу Motion запущено.',
    motionStopped: '✅ Службу Motion зупинено.',
    alreadyRunning: 'ℹ️ Служба Motion уже працює.',
    cameraNotFound: (name: string) => `❌ Камеру '${name}' не знайдено.`,
    noCameras: '❌ Камери не налаштовано.',
    motionNotRunning: '❌ Служба Motion не працює. Адміністратор: /camera enable',
    snapshotFailed: '❌ Не вдалося зробити знімок.',
    invalidDate: '❌ Неправильна дата. Використовуйте формат: DD.MM.YYYY',
    eventNotFound: (id: number) => `❌ Подію №${id} не знайдено.`,
    videoUnavailable: '❌ Відеофайл більше недоступний.',
    noSnapshotForEvent: (id: number) => `❌ Для події №${id} немає знімка.`,
    snapshotFileGone: '❌ Файл знімка більше недоступний.',
    startFailed: (reason: string) => `❌ Не вдалося запустити службу Motion: ${reason}`,
    stopFailed: (reason: string) => `❌ Не вдалося зупинити службу Motion: ${reason}`,
    notInstalled: '❌ Motion не встановлено. Повторно запустіть встановлення з увімкненою можливістю камери.',
    live: {
      experimentalLabel: 'Експериментальний перегляд наживо',
      opening: '⏳ Відкриваємо експериментальний перегляд наживо…',
      opened: (minutes: number) =>
        `🧪 Експериментальний перегляд наживо доступний приблизно ${minutes} хв.`,
      watchButton: 'Дивитися наживо',
      unavailable: '❌ Експериментальний перегляд наживо зараз недоступний.',
      sourceUnavailable: '❌ Потік наживо з камери недоступний.',
      stopped: '✅ Перегляд наживо зупинено.',
      noActive: 'ℹ️ Активного перегляду наживо немає.',
      expired: 'ℹ️ Термін дії посилання на перегляд наживо минув.',
      adminFailure: '⚠️ Помилка експериментального перегляду наживо. Перевірте worker і діагностику тунелю.',
    },
    adminAlert: {
      daemonDown:
        '🚨 Служба Motion не працює та не змогла автоматично перезапуститися. Запис камери не в мережі.',
      daemonRecovered: '✅ Служба Motion відновилася. Запис камери знову в мережі.',
      gdriveSyncFailing: (error: string) =>
        `⚠️ Не вдається синхронізувати з Google Drive: ${error}`,
      diskWarning:
        '⚠️ Використання диска високе й наближається до критичного порогу. Якщо воно продовжить зростати, завантажені медіафайли буде очищено автоматично.',
      emergencyDiskCleanup:
        '🚨 Виконано аварійне очищення диска: старі події й журнали видалено, а службу Motion зупинено, щоб звільнити місце.',
      liveStreamRecoveryFailed:
        '⚠️ Не вдалося перевірити застарілий процес прямої трансляції, тому його не було зупинено.',
    },
  },

  gdrive: {
    usage: 'Використання: /gdrive status',
    header: '☁️ Стан Google Drive',
    body: (v: GdriveStatusView): string => {
      const lines = [
        `📦 Використано: ${gb(v.usedBytes)} / ${gb(v.totalBytes)} (${percent(v.usedBytes, v.totalBytes)})`,
        `📤 Останнє завантаження: ${fmtDate(v.lastUploadAt)}`,
        `📋 Очікують завантаження: ${v.pendingUploads} ${plural(v.pendingUploads, 'файл', 'файли', 'файлів')}`,
        v.failedUploads > 0 && v.lastError
          ? `⚠️ Невдалих завантажень: ${v.failedUploads} (остання помилка: ${v.lastError})`
          : `⚠️ Невдалих завантажень: ${v.failedUploads}`,
        `🗑️ Автоочищення: активне (мінімальний вік: ${v.cleanupMinAgeDays} ${plural(v.cleanupMinAgeDays, 'день', 'дні', 'днів')})`,
      ];
      if (v.failedUploads >= 5) {
        lines.push(`🚨 Проблеми із синхронізацією — ${v.failedUploads} невдалих спроб поспіль`);
      }
      return lines.join('\n');
    },
    notInstalled: '❌ rclone не встановлено.',
    notConfigured: '❌ Google Drive не налаштовано. Запустіть rclone config.',
    statusFailed: (reason: string) => `❌ Не вдалося перевірити стан Drive: ${reason}`,
    cleanButton: '🧹 Запустити очищення зараз',
  },

  gdriveAuth: {
    prompt: (sshHost: string) =>
      '☁️ *Налаштування автентифікації Google Drive*\n\n' +
      'Вставте нижче розділ конфігурації rclone `[gdrive]` або завантажте файл `rclone.conf`.\n\n' +
      'Щоб налаштувати Drive безпосередньо на Pi, виконайте на своєму ноутбуці:\n' +
      `\`ssh pi@${sshHost} sudo -H -u homeworker env RCLONE_CONFIG=/home/homeworker/.config/rclone/rclone.conf rclone config\`\n\n` +
      'Створіть або оновіть віддалене сховище `gdrive` типу `drive`. На Pi без графічного інтерфейсу відповідайте `n` на автентифікацію через браузер; якщо rclone виведе `rclone authorize "drive"`, виконайте цю команду на комп’ютері з браузером і вставте токен у сесію SSH.\n\n' +
      'Коли пряме налаштування завершиться, надішліть сюди /cancel, а потім виконайте /gdrive status.',
    success: (used: string, total: string) =>
      `✅ Google Drive підключено!\n📦 ${used} / ${total}`,
    failed: (reason: string) =>
      `❌ Не вдалося оновити автентифікацію: ${reason}\nПопередню конфігурацію відновлено.`,
    notInstalled:
      '❌ rclone не встановлено. Повторно запустіть встановлення з увімкненою можливістю камери.',
    alreadyInProgress: '⏳ Оновлення автентифікації вже виконується. Надішліть /cancel, щоб скасувати.',
    cancelled: '☁️ Налаштування автентифікації Google Drive скасовано.',
    invalidSnippet:
      '❌ Це не схоже на розділ конфігурації rclone. Очікується заголовок `[gdrive]`.',
    button: '☁️ Налаштувати GDrive',
  },

  settings: {
    title: (threshold: number) =>
      `⚙️ *Параметри роботи системи*\n\n*Поріг запуску автоочищення:* ${threshold}%\n_(Коли використання диска або Drive досягне цього рівня, завантажені медіафайли й старі файли буде очищено автоматично.)_\n\nВиберіть готовий поріг або запустіть очищення:`,
    updated: (threshold: number) =>
      `✅ Поріг автоочищення оновлено до *${threshold}%*.`,
    buttons: {
      t70: '70%',
      t75: '75%',
      t80: '80%',
      t85: '85%',
      t90: '90%',
      cleanNow: '🧹 Запустити очищення зараз',
    },
    invalidThreshold: '⚠️ Неправильний поріг: має бути від 10% до 99%.',
  },

  clean: {
    triggered: (threshold: number) =>
      `🧹 *Ручне очищення запущено*\n\nВиконано очищення локального диска та Google Drive (використаний поріг: *${threshold}%*). Старі й завантажені файли перевірено та видалено за потреби.`,
    inProgress: '⏳ Очищення сховища вже виконується. Спробуйте ще раз трохи згодом.',
    invalidThreshold: '⚠️ Неправильний поріг: має бути цілим числом від 10% до 99%.',
    button: '🧹 Запустити очищення зараз',
  },

  exportConfig: {
    caption: '📄 Поточна конфігурація. Відредагуйте та надішліть назад через /import_config.',
    failed: '❌ Не вдалося експортувати конфігурацію.',
  },

  importConfig: {
    prompt: 'Надішліть YAML-файл конфігурації.',
    invalidFormat: '❌ Неправильний формат файлу. Надішліть файл .yml.',
    tooLarge: '❌ Файл завеликий. Надішліть конфігураційний файл до 1 МБ.',
    parseError: (details: string) => `❌ Помилка розбору YAML: ${details}`,
    validationFailed: (errors: string[]): string =>
      [
        '❌ Перевірка конфігурації не пройшла:',
        '',
        ...errors.map((e) => `• ${e}`),
        '',
        'Виправте та завантажте повторно.',
      ].join('\n'),
    noChanges: 'ℹ️ Конфігурація відповідає поточним налаштуванням. Застосовувати нічого.',
    invalidLiveSources: 'Метадані джерел відео некоректні або містять непідтримувані поля.',
    summary: (s: ImportSummary & { liveSources?: string[] }): string => {
      const lines = ['📋 Підсумок імпорту:', ''];
      lines.push(
        s.added.length > 0 ? `➕ Додати: ${s.added.join(', ')}` : '➕ Додати: немає',
      );
      lines.push(
        s.liveSources?.length
          ? `📷 Налаштувати джерела відео: ${s.liveSources.join(', ')}`
          : '📷 Налаштувати джерела відео: немає',
      );
      lines.push(
        s.updated.length > 0
          ? `🔄 Оновити: ${s.updated.map((u) => `${u.name} (${u.detail})`).join(', ')}`
          : '🔄 Оновити: немає',
      );
      lines.push(
        s.archived.length > 0
          ? `🗄️ Архівувати: ${s.archived.join(', ')}`
          : '🗄️ Архівувати: немає',
      );
      lines.push('', 'Застосувати зміни?');
      return lines.join('\n');
    },
    applyButton: 'Застосувати',
    cancelButton: '❌ Скасувати',
    applied: (s: ImportSummary & { liveSources?: string[] }): string =>
      `✅ Конфігурацію імпортовано. Додано: ${s.added.length}, оновлено: ${s.updated.length}, архівовано: ${s.archived.length}, джерел відео без облікових даних: ${s.liveSources?.length ?? 0}.`,
    applyFailed: '❌ Імпорт завершився помилкою до застосування змін.',
    partialFailed: '⚠️ Метадані джерел відео застосовано; імпорт датчиків завершився некоректно, і його зміни бази даних також могли бути застосовані. Перевірте поточну конфігурацію перед повтором.',
    sensorOutcomeUncertain: '⚠️ Імпорт датчиків завершився некоректно, і зміни бази даних могли бути застосовані. Перевірте поточну конфігурацію перед повтором.',
    partialRoleChanged: '⚠️ Метадані джерел відео застосовано, але імпорт датчиків зупинено через зміну прав адміністратора.',
    cancelled: 'Імпорт скасовано. Змін не внесено.',
    failed: (reason: string) =>
      `❌ Імпорт не вдався: ${reason}. Змін не внесено.`,
  },

  system: {
    online: (v: SystemOnlineView): string => {
      const lines = ['🟢 Система в мережі', `🔌 Датчики: ${v.sensorsOnline}/${v.sensorsTotal} у мережі`];
      if (v.dbRecovery === 'restored_from_backup') {
        lines.push('⚠️ Базу даних відновлено з локальної резервної копії після пошкодження.');
      } else if (v.dbRecovery === 'recreated_empty') {
        lines.push('⚠️ Після пошкодження створено порожню базу даних — повторно імпортуйте конфігурацію.');
      }
      if (!v.clockSynchronized) {
        lines.push('⚠️ Системний годинник не синхронізовано — ранні мітки часу можуть бути неточними.');
      }
      lines.push(fmtDate(v.now));
      return lines.join('\n');
    },
    goingOffline: '🔴 Система вимикається.',
  },
} satisfies LocaleCatalog;

export const uk = deepFreeze(ukCatalog);

export interface ConfigDisplay {
  name: string;
  type: SensorType;
  config: Record<string, unknown>;
  debounceMs: number;
  severity: SensorSeverity;
}
