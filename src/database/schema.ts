import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  muted: integer('muted', { mode: 'boolean' }).default(false),
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
