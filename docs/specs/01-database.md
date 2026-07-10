# 01 — Database

## Dependencies
- 00-overview.md (tech stack, .env)

## Setup

```typescript
// src/database/database.module.ts
@Module({
  providers: [{
    provide: 'DB',
    useFactory: () => {
      const sqlite = new Database(process.env.DATABASE_PATH);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('synchronous = NORMAL');
      sqlite.pragma('busy_timeout = 5000');
      return drizzle(sqlite, { schema });
    },
  }],
  exports: ['DB'],
})
export class DatabaseModule {}
```

## Schema

```typescript
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ─── Sensors ───
export const sensors = sqliteTable('sensors', {
  id:          text('id').primaryKey(),
  name:        text('name').notNull().unique(),
  type:        text('type').notNull(),              // 'digital' | 'uart' | 'mqtt' | 'camera'
  config:      text('config', { mode: 'json' }),
  enabled:     integer('enabled', { mode: 'boolean' }).default(true),
  debounceMs:  integer('debounce_ms').default(10000),
  severity:    text('severity').default('info'),    // 'info' | 'warning' | 'critical'
  lastValue:   text('last_value'),
  lastValueAt: integer('last_value_at', { mode: 'timestamp' }),
  createdAt:   integer('created_at', { mode: 'timestamp' }),
  updatedAt:   integer('updated_at', { mode: 'timestamp' }),
});

// ─── Sensors Archive ───
export const sensorsArchive = sqliteTable('sensors_archive', {
  id:          text('id').primaryKey(),
  name:        text('name').notNull(),
  type:        text('type').notNull(),
  config:      text('config', { mode: 'json' }),
  debounceMs:  integer('debounce_ms'),
  severity:    text('severity'),
  lastValue:   text('last_value'),
  lastValueAt: integer('last_value_at', { mode: 'timestamp' }),
  createdAt:   integer('created_at', { mode: 'timestamp' }),
  archivedAt:  integer('archived_at', { mode: 'timestamp' }),
});

// ─── Events ───
export const events = sqliteTable('events', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  sensorId:  text('sensor_id'),
  type:      text('type').notNull(),                // 'state_change' | 'threshold' | 'motion' | 'system'
  payload:   text('payload', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  sentAt:    integer('sent_at', { mode: 'timestamp' }),
}, (table) => [
  index('idx_events_unsent').on(table.sentAt),
  index('idx_events_sensor_time').on(table.sensorId, table.createdAt),
]);

// ─── Sensor Logs ───
export const sensorLogs = sqliteTable('sensor_logs', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  sensorId:  text('sensor_id'),
  level:     text('level').notNull(),
  message:   text('message').notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }),
}, (table) => [
  index('idx_sensor_logs_sensor_time').on(table.sensorId, table.timestamp),
]);

// ─── Users ───
export const users = sqliteTable('users', {
  telegramId: integer('telegram_id').primaryKey(),
  name:       text('name').notNull(),
  role:       text('role').notNull().default('user'),
  muted:      integer('muted', { mode: 'boolean' }).default(false),
  quietStart: text('quiet_start'),
  quietEnd:   text('quiet_end'),
  createdBy:  integer('created_by'),
  createdAt:  integer('created_at', { mode: 'timestamp' }),
});

// ─── User-Sensor Mutes ───
export const userSensorMutes = sqliteTable('user_sensor_mutes', {
  userId:    integer('user_id').references(() => users.telegramId),
  sensorId:  text('sensor_id'),
}, (table) => [
  uniqueIndex('idx_user_sensor_mute').on(table.userId, table.sensorId),
]);

// ─── Invite Codes ───
export const inviteCodes = sqliteTable('invite_codes', {
  code:      text('code').primaryKey(),
  role:      text('role').notNull().default('user'),
  createdBy: integer('created_by').references(() => users.telegramId),
  usedBy:    integer('used_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  usedAt:    integer('used_at', { mode: 'timestamp' }),
});

// ─── Cameras ───
export const cameras = sqliteTable('cameras', {
  id:      text('id').primaryKey(),
  name:    text('name').notNull().unique(),
  type:    text('type').notNull(),
  config:  text('config', { mode: 'json' }),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
});

// ─── Motion Events ───
export const motionEvents = sqliteTable('motion_events', {
  id:               integer('id').primaryKey({ autoIncrement: true }),
  cameraId:         text('camera_id').references(() => cameras.id),
  startedAt:        integer('started_at', { mode: 'timestamp' }),
  endedAt:          integer('ended_at', { mode: 'timestamp' }),
  videoPath:        text('video_path'),
  snapshotPath:     text('snapshot_path'),
  uploadedToGdrive: integer('uploaded_to_gdrive', { mode: 'boolean' }).default(false),
  gdriveFileId:     text('gdrive_file_id'),
  localDeleted:     integer('local_deleted', { mode: 'boolean' }).default(false),
}, (table) => [
  index('idx_motion_camera_time').on(table.cameraId, table.startedAt),
  index('idx_motion_not_uploaded').on(table.uploadedToGdrive),
]);

// ─── Features ───
export const features = sqliteTable('features', {
  name:      text('name').primaryKey(),
  enabled:   integer('enabled', { mode: 'boolean' }).default(false),
  installed: integer('installed', { mode: 'boolean' }).default(false),
  config:    text('config', { mode: 'json' }),
});

// ─── System Metadata ───
export const systemMeta = sqliteTable('system_meta', {
  key:   text('key').primaryKey(),
  value: text('value'),
});
```

## Sensor Deletion Flow

1. Sensor driver destroyed
2. Row moved from `sensors` → `sensors_archive` (INSERT + DELETE in transaction)
3. Events and logs retain `sensor_id` referencing the archive
4. GPIO pin becomes available for re-use

## Migration Strategy

- Drizzle Kit generates SQL files in `migrations/`
- On startup, check `system_meta` for schema version, apply pending
- Integrity recovery happens before migration. Any migration exception is fatal;
  PM2 may restart the worker, but it must never serve against an incompatible
  schema.
- Migrations must be backward-compatible (old code works with new schema for rollback)
- OTA update runs migrations before PM2 restart

## Retention Policies

| Table | Retention | Mechanism |
|-------|-----------|-----------|
| `events` (sent) | 30 days (`EVENT_RETENTION_DAYS`) | Daily cron prune |
| `events` (unsent) | Infinite | Never pruned until sent |
| `sensor_logs` | 30 days (`LOG_RETENTION_DAYS`) | Daily cron prune |
| `motion_events` | Infinite in DB | Local files cleaned by CleanupService |
| PM2 logs | pm2-logrotate | Auto |

## Write Optimization

- WAL mode reduces write amplification
- `synchronous=NORMAL` — acceptable tradeoff
- `busy_timeout=5000` — prevents SQLITE_BUSY during rclone I/O
- CO2 readings: buffer in memory, flush every 60s
- Digital events: write immediately (low frequency ~20/day)
- Mount `/tmp` and `/var/log` as tmpfs

## Database Backup

- Daily via SQLite Online Backup API (allows concurrent reads/writes)
- Scheduled at 3 AM (`BACKUP_CRON`)
- Local: `BACKUP_LOCAL_PATH` (survives DB corruption)
- Remote: rclone to `gdrive:home-security/backups/worker-YYYY-MM-DD.db`
- Keep last 7 backups on Drive
- On corruption: recover from local backup → notify admin
