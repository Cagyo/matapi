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
import { sqliteTable, text, integer, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  // Timed non-critical pause deadline (1/4/8h); null = no timed pause.
  // Legacy `muted = true` remains an indefinite pause until Resume clears it.
  nonCriticalPausedUntil:    integer('non_critical_paused_until', { mode: 'timestamp' }),
  // Compare-and-swap guard: every change to `muted` or `nonCriticalPausedUntil`
  // increments it, superseding any stale Undo receipt.
  notificationPauseRevision: integer('notification_pause_revision').notNull().default(0),
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

// ─── Notification Pause Receipts ───
// One row per timed global-pause application, enabling revision-safe Undo of
// the latest pause. `expiresAt` equals the applied deadline for a global pause
// but is a first-class column because future action types have independent
// Undo windows. Only the newest receipt per user is undoable; retention is
// capped at 32 rows per user in the repository (older rows report `superseded`,
// evicted ids `not_found`).
export const notificationPauseReceipts = sqliteTable('notification_pause_receipts', {
  id:                  integer('id').primaryKey({ autoIncrement: true }),
  userId:              integer('user_id').notNull()
                         .references(() => users.telegramId, { onDelete: 'cascade' }),
  previousPausedUntil: integer('previous_paused_until', { mode: 'timestamp' }),
  appliedPausedUntil:  integer('applied_paused_until', { mode: 'timestamp' }).notNull(),
  expectedRevision:    integer('expected_revision').notNull(),
  expiresAt:           integer('expires_at', { mode: 'timestamp' }).notNull(),
  consumedAt:          integer('consumed_at', { mode: 'timestamp' }),
  createdAt:           integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  index('idx_notification_pause_receipts_user_id').on(table.userId, table.id),
]);

// ─── Authoritative Home Sessions ───
// Exactly one row per Telegram user/private-chat pair. Active and pending
// render identities live in the same row so every authority transition is a
// compare-and-swap transaction.
export const homeSessions = sqliteTable('home_sessions', {
  userId:            integer('user_id').notNull()
                       .references(() => users.telegramId, { onDelete: 'cascade' }),
  chatId:            integer('chat_id').notNull(),
  activeMessageId:   integer('active_message_id'),
  activeToken:       text('active_token'),
  activeRevision:    integer('active_revision'),
  activeView:        text('active_view'),
  activeSensorPage:  integer('active_sensor_page'),
  activeViewPayload: text('active_view_payload'), // nullable canonical Home-view JSON
  activeChecking:    integer('active_checking', { mode: 'boolean' }),
  pendingKind:       text('pending_kind'),          // 'new' | 'edit'
  // Null only for a new-message reservation until Telegram send returns;
  // edit reservations store the active message ID immediately.
  pendingMessageId:  integer('pending_message_id'),
  pendingToken:      text('pending_token'),
  pendingRevision:   integer('pending_revision'),
  pendingView:       text('pending_view'),
  pendingSensorPage: integer('pending_sensor_page'),
  pendingViewPayload:text('pending_view_payload'), // nullable canonical Home-view JSON
  pendingChecking:   integer('pending_checking', { mode: 'boolean' }),
  pendingExpiresAt:  integer('pending_expires_at', { mode: 'timestamp' }),
  updatedAt:         integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.chatId] }),
  index('idx_home_sessions_pending_expiry').on(table.pendingExpiresAt),
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

// ─── Home Action Receipts ───
// Exactly one bounded current row per (user, private chat, action kind).
// Replacement invalidates the prior receipt; this is not an action history.
export const homeActionReceipts = sqliteTable('home_action_receipts', {
  userId:       integer('user_id').notNull().references(() => users.telegramId, { onDelete: 'cascade' }),
  chatId:       integer('chat_id').notNull(),
  kind:         text('kind').notNull(),
  id:           text('id').notNull(),
  sessionToken: text('session_token'),
  status:       text('status').notNull(), // pending | executing | completed | failed
  payload:      text('payload').notNull(),
  expiresAt:    integer('expires_at', { mode: 'timestamp' }).notNull(),
  updatedAt:    integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.chatId, table.kind] })]);

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

## Authoritative Home-session protocol

`home_sessions` is deliberately one composite-key row, not a history table:
the `(user_id, chat_id)` primary key binds the only accepted Home to the
Telegram user and private chat. The active fields hold the promoted
`messageId`, 96-bit base64url token, bounded revision, view, page, and checking
state. The parallel pending fields hold an exact new-message or in-place-edit
reservation. `pending_expires_at` is always 60 seconds after reservation; an
expired pending reservation is cleared (or its otherwise-empty row removed)
without changing an existing active Home.

`active_view_payload` and `pending_view_payload` are nullable, bounded JSON
columns for the canonical Home view only; the adapter rejects malformed or
non-canonical values rather than coercing them. `home_action_receipts` has one
current row per `(user_id, chat_id, kind)`: `pending` receipts expire, external
cleanup/restart is atomically claimed as `executing`, and it reaches
`completed` or `failed` exactly once. A replacement receipt makes the prior
one stale, so retries cannot execute external work twice.

`user_sensor_mutes.sensor_id` is a namespaced target key: `sensor:<id>` for a
sensor and `camera:<id>` for a camera. The namespace prevents equal raw IDs
from colliding across notification target types.

The Drizzle adapter at
[`src/telegram/infrastructure/drizzle-home-session.store.ts`](../../src/telegram/infrastructure/drizzle-home-session.store.ts)
uses SQLite immediate transactions and row-wide compare-and-swap guards for
reserve, promote, validation, expiry, and close. The mock/test composition
uses `InMemoryHomeSessionStore`, but production authority survives process
restart in this table. Do not hand-edit its migration: edit
[`src/database/schema.ts`](../../src/database/schema.ts) and run `yarn db:generate`.

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
