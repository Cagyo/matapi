import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { DEFAULT_LOCALE } from '../telegram/domain/locale';
import type { LiveSourceSettings } from '../camera/domain/live-source.entity';

// ─── Sensors ───
export const sensors = sqliteTable('sensors', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  type: text('type').notNull(), // 'digital' | 'uart' | 'mqtt' | 'camera'
  config: text('config', { mode: 'json' }),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  debounceMs: integer('debounce_ms').default(10000),
  severity: text('severity').default('info'), // 'info' | 'warning' | 'critical'
  lastValue: text('last_value'),
  lastValueAt: integer('last_value_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

// ─── Sensors Archive ───
export const sensorsArchive = sqliteTable('sensors_archive', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  config: text('config', { mode: 'json' }),
  debounceMs: integer('debounce_ms'),
  severity: text('severity'),
  lastValue: text('last_value'),
  lastValueAt: integer('last_value_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
});

// ─── Events ───
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sensorId: text('sensor_id'),
    type: text('type').notNull(), // 'state_change' | 'threshold' | 'motion' | 'system'
    payload: text('payload', { mode: 'json' }),
    createdAt: integer('created_at', { mode: 'timestamp' }),
    sentAt: integer('sent_at', { mode: 'timestamp' }),
  },
  (table) => [
    index('idx_events_unsent').on(table.sentAt),
    index('idx_events_sensor_time').on(table.sensorId, table.createdAt),
  ],
);

// ─── Sensor Logs ───
export const sensorLogs = sqliteTable(
  'sensor_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sensorId: text('sensor_id'),
    level: text('level').notNull(),
    message: text('message').notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp' }),
  },
  (table) => [index('idx_sensor_logs_sensor_time').on(table.sensorId, table.timestamp)],
);

// ─── Users ───
export const users = sqliteTable('users', {
  telegramId: integer('telegram_id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull().default('user'),
  locale: text('locale').notNull().default(DEFAULT_LOCALE),
  muted: integer('muted', { mode: 'boolean' }).default(false),
  // Timed non-critical pause deadline (1/4/8h). `null` = no timed pause active.
  // Legacy `muted = true` remains an indefinite pause until Resume clears it.
  nonCriticalPausedUntil: integer('non_critical_paused_until', { mode: 'timestamp' }),
  // Compare-and-swap guard for pause/resume/undo mutations; every state change
  // to muted or nonCriticalPausedUntil increments it, superseding stale receipts.
  notificationPauseRevision: integer('notification_pause_revision')
    .notNull()
    .default(0),
  quietStart: text('quiet_start'),
  quietEnd: text('quiet_end'),
  createdBy: integer('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

// ─── User-Sensor Mutes ───
export const userSensorMutes = sqliteTable(
  'user_sensor_mutes',
  {
    userId: integer('user_id').references(() => users.telegramId),
    sensorId: text('sensor_id'),
  },
  (table) => [uniqueIndex('idx_user_sensor_mute').on(table.userId, table.sensorId)],
);

// ─── Notification Pause Receipts ───
// One per timed global-pause application, enabling revision-safe Undo. Only the
// newest receipt for a user is undoable; retention is capped per user in the
// repository. `expiresAt` equals the applied deadline for a global pause but is
// kept as a first-class column because future action types have independent
// Undo windows.
export const notificationPauseReceipts = sqliteTable(
  'notification_pause_receipts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.telegramId, { onDelete: 'cascade' }),
    previousPausedUntil: integer('previous_paused_until', { mode: 'timestamp' }),
    appliedPausedUntil: integer('applied_paused_until', { mode: 'timestamp' }).notNull(),
    expectedRevision: integer('expected_revision').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('idx_notification_pause_receipts_user_id').on(table.userId, table.id),
  ],
);

// ─── Authoritative Home Sessions ───
// Active and pending Home render identities are kept together so their CAS
// transitions can be committed atomically per Telegram user/chat pair.
export const homeSessions = sqliteTable(
  'home_sessions',
  {
    userId: integer('user_id').notNull().references(() => users.telegramId, { onDelete: 'cascade' }),
    chatId: integer('chat_id').notNull(),
    activeMessageId: integer('active_message_id'),
    activeToken: text('active_token'),
    activeRevision: integer('active_revision'),
    activeView: text('active_view'),
    activeSensorPage: integer('active_sensor_page'),
    activeChecking: integer('active_checking', { mode: 'boolean' }),
    pendingKind: text('pending_kind'),
    pendingMessageId: integer('pending_message_id'),
    pendingToken: text('pending_token'),
    pendingRevision: integer('pending_revision'),
    pendingView: text('pending_view'),
    pendingSensorPage: integer('pending_sensor_page'),
    pendingChecking: integer('pending_checking', { mode: 'boolean' }),
    pendingExpiresAt: integer('pending_expires_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.chatId] }),
    index('idx_home_sessions_pending_expiry').on(table.pendingExpiresAt),
  ],
);

// ─── Invite Codes ───
export const inviteCodes = sqliteTable('invite_codes', {
  code: text('code').primaryKey(),
  role: text('role').notNull().default('user'),
  createdBy: integer('created_by').references(() => users.telegramId),
  usedBy: integer('used_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  usedAt: integer('used_at', { mode: 'timestamp' }),
});

// ─── Cameras ───
export const cameras = sqliteTable('cameras', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  type: text('type').notNull(),
  config: text('config', { mode: 'json' }),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
});

// ─── Camera Live Sources ───
export const cameraLiveSources = sqliteTable('camera_live_sources', {
  cameraId: text('camera_id')
    .primaryKey()
    .references(() => cameras.id, { onDelete: 'cascade' }),
  normalizedUrl: text('normalized_url').notNull(),
  settings: text('settings', { mode: 'json' })
    .$type<LiveSourceSettings>()
    .notNull(),
  ready: integer('ready', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const cameraLiveCredentials = sqliteTable('camera_live_credentials', {
  cameraId: text('camera_id')
    .primaryKey()
    .references(() => cameraLiveSources.cameraId, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),
  nonce: text('nonce').notNull(),
  authTag: text('auth_tag').notNull(),
  keyVersion: integer('key_version').notNull(),
});

// ─── Motion Events ───
export const motionEvents = sqliteTable(
  'motion_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cameraId: text('camera_id').references(() => cameras.id),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    endedAt: integer('ended_at', { mode: 'timestamp' }),
    videoPath: text('video_path'),
    snapshotPath: text('snapshot_path'),
    uploadedToGdrive: integer('uploaded_to_gdrive', { mode: 'boolean' }).default(false),
    /** With the rclone adapter this holds the remote *path* (e.g.
     * `home-security/motion/2026/07/08/1.mp4`), NOT a Google Drive API file id. */
    gdriveFileId: text('gdrive_file_id'),
    localDeleted: integer('local_deleted', { mode: 'boolean' }).default(false),
  },
  (table) => [
    index('idx_motion_camera_time').on(table.cameraId, table.startedAt),
    index('idx_motion_not_uploaded').on(table.uploadedToGdrive),
  ],
);

// ─── Features ───
export const features = sqliteTable('features', {
  name: text('name').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).default(false),
  installed: integer('installed', { mode: 'boolean' }).default(false),
  config: text('config', { mode: 'json' }),
});

// ─── System Metadata ───
export const systemMeta = sqliteTable('system_meta', {
  key: text('key').primaryKey(),
  value: text('value'),
});
