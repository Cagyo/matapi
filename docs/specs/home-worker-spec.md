# Home Worker — System Specification

## Document Info

- **Version:** 2.0
- **Date:** 2026-04-08
- **Status:** Architecture finalized, ready for implementation

---

## 1. Overview

Home Worker is a home automation and security monitoring system running on Raspberry Pi. It reads sensor data via GPIO, processes events, stores them locally, and communicates with users through a Telegram chatbot. The system is designed to operate reliably with intermittent internet connectivity, survive power loss, and be updatable over the air.

---

## 2. Hardware

| Component | Details |
|-----------|---------|
| **Minimum platform** | Raspberry Pi 3 (1GB RAM) |
| **Current platform** | Raspberry Pi 5 |
| **OS** | Raspbian (latest) |
| **Power** | UPS hat (provides graceful shutdown window) |
| **Storage** | SD card |
| **RTC** | DS3231 module recommended (no hardware RTC on Pi, clock drift when offline) |
| **GPIO daemon** | pigpiod (runs as root, worker connects via socket) |
| **Future hardware** | USB Zigbee dongle (CC2652 / SONOFF ZBDongle-P), USB 4G modem |

### Why No Pico

Raspberry Pi Pico was considered as a GPIO coprocessor but is deferred. With ≤5 sensors and Node.js on Pi 3/5, the complexity of a serial protocol between Pico and Pi is not justified. Can be revisited if GC-related timing issues appear at 50+ sensors.

---

## 3. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Runtime** | Node.js 20 | LTS, pinned to major version |
| **Framework** | NestJS | Acceptable overhead on Pi 3+, already in use |
| **Database** | SQLite via better-sqlite3 | WAL mode, synchronous=NORMAL, busy_timeout=5000 |
| **ORM** | Drizzle ORM | Lightweight, TypeScript-first, uses better-sqlite3 under the hood |
| **Telegram** | grammY | Built-in reconnect (`@grammyjs/runner`), auto-retry, best TypeScript DX |
| **Process manager** | PM2 | With pm2-logrotate, max_memory_restart=512M, instances=1 |
| **GPIO** | pigpio (socket mode) | Worker runs as non-root, connects to pigpiod daemon |
| **UART** | serialport npm | For CO2 sensor |
| **Sidecar: MQTT** | Mosquitto (future) | For Zigbee2MQTT integration |
| **Sidecar: Camera** | Motion daemon | Managed via systemd, worker controls via sudo |
| **Cloud sync** | rclone | Google Drive, service account auth (no token expiry) |

---

## 4. Phased Delivery

### Phase 0 — MVP (1-2 weeks)

Ship a working system monitoring 5 sensors with Telegram notifications.

- NestJS + Drizzle + SQLite
- Digital sensor driver (pigpio via socket)
- grammY bot: `/status`, `/claim_admin`, notifications
- Event queue with offline buffer + batched drain (at-least-once delivery)
- PM2 with pm2-logrotate, max_memory_restart, single instance enforcement
- Simple install script (no wizard), manual `.env` setup
- External heartbeat monitoring (UptimeRobot or similar)
- Mock GPIO driver for development on non-Pi machines
- `.env` in `.gitignore` + pre-commit hook
- PID lockfile to prevent duplicate instances

### Phase 1 — Usable Product

After MVP runs reliably for 2+ weeks.

- Setup web wizard (standalone script, not NestJS)
- Sensor CRUD via bot (conversational flow + inline keyboards)
- Role management (admin/user)
- CO2 UART driver
- `/logs`, `/health`, `/help`, `/ping`, `/restart` commands
- OTA `/update` + `/rollback` commands
- Motion camera module
- Google Drive sync (rclone) + bidirectional cleanup
- Database backup to Google Drive (daily)
- YAML import/export for config (with schema validation)
- Feature toggle system (install-time selection; bot only toggles pre-installed features)
- Notification preferences (mute, quiet hours, debounce)

### Phase 2 — Extended Features

- Zigbee + MQTT (Zigbee2MQTT sidecar)
- Flow engine (trigger → action, e.g., water → phone call)
- 4G failover (NetworkService with auto-switch)
- Neobox intercom integration (pending model investigation)
- Multi-camera support
- System update management (`/system_update`)
- Process separation (critical sensor monitor vs non-critical bot/camera)

---

## 5. Architecture

### 5.1 High-Level Diagram

```
┌──────────────┐  hooks   ┌──────────────────────────────────┐
│   motion     │─────────►│  NestJS Worker                   │
│  (systemd)   │          │                                  │
└──────────────┘          │  ┌─ SensorModule                 │
                          │  │   ├─ SensorRegistry           │
┌──────────────┐  socket  │  │   ├─ DigitalDriver (pigpio)   │
│   pigpiod    │◄─────────│  │   ├─ UartDriver (serialport)  │
│  (systemd)   │          │  │   ├─ MqttDriver (future)      │
└──────────────┘          │  │   └─ CameraDriver (ffmpeg)    │
                          │  │                               │
┌──────────────┐  MQTT    │  ├─ EventModule                  │
│ Zigbee2MQTT  │◄────────►│  │   ├─ EventQueue (SQLite)      │
│ (future)     │          │  │   └─ EventProcessor           │
└──────────────┘          │  │                               │
                          │  ├─ TelegramModule               │
┌──────────────┐  rclone  │  │   ├─ Commands                 │
│ Google Drive │◄─────────│  │   ├─ RoleGuard                │
│              │          │  │   └─ FlowEngine (future)      │
└──────────────┘          │  │                               │
                          │  ├─ CameraModule                 │
                          │  │   ├─ MotionService            │
                          │  │   ├─ UploadService (rclone)   │
                          │  │   └─ CleanupService           │
                          │  │                               │
                          │  ├─ NetworkModule                │
                          │  │   └─ NetworkService           │
                          │  │                               │
                          │  └─ DatabaseModule               │
                          │      └─ Drizzle + SQLite         │
                          └──────────────────────────────────┘
```

### 5.2 Project Structure

```
repo/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── sensors/
│   │   ├── sensor.module.ts
│   │   ├── sensor.registry.ts          # hot-reloadable, SQLite-backed
│   │   ├── sensor.interface.ts         # ISensorDriver contract
│   │   └── drivers/
│   │       ├── digital.driver.ts       # pigpio socket
│   │       ├── uart.driver.ts          # CO2 via serialport
│   │       ├── mqtt.driver.ts          # Zigbee (future)
│   │       ├── camera.driver.ts        # RTSP/ffmpeg snapshots
│   │       └── mock.driver.ts          # dev simulator
│   ├── events/
│   │   ├── event.module.ts
│   │   ├── event.queue.ts              # SQLite-backed, offline buffer
│   │   └── event.processor.ts          # batched drain on reconnect
│   ├── telegram/
│   │   ├── bot.module.ts
│   │   ├── commands/
│   │   │   ├── status.command.ts
│   │   │   ├── logs.command.ts
│   │   │   ├── config.command.ts       # sensor CRUD, conversational flow
│   │   │   ├── camera.command.ts
│   │   │   ├── update.command.ts       # OTA app update
│   │   │   ├── users.command.ts        # invite/promote/demote
│   │   │   ├── health.command.ts       # disk, CPU temp, memory, uptime
│   │   │   ├── help.command.ts         # role-aware help text
│   │   │   ├── ping.command.ts
│   │   │   ├── restart.command.ts
│   │   │   ├── mute.command.ts         # per-sensor mute
│   │   │   ├── quiet-hours.command.ts
│   │   │   ├── export-config.command.ts
│   │   │   ├── import-config.command.ts
│   │   │   └── feature.command.ts      # enable/disable pre-installed features
│   │   ├── guards/
│   │   │   └── role.guard.ts           # admin vs user permission check
│   │   └── flows/
│   │       └── flow.engine.ts          # trigger → action (future)
│   ├── camera/
│   │   ├── camera.module.ts
│   │   ├── motion.service.ts           # motion daemon lifecycle
│   │   ├── upload.service.ts           # rclone to Google Drive
│   │   └── cleanup.service.ts          # local + Drive cleanup
│   ├── network/
│   │   ├── network.module.ts
│   │   └── network.service.ts          # health checks, future 4G failover
│   ├── database/
│   │   ├── database.module.ts
│   │   ├── schema.ts                   # Drizzle schema definitions
│   │   └── backup.service.ts           # daily SQLite backup + Drive upload
│   └── config/
│       └── config.loader.ts            # env + feature flags
├── migrations/                         # Drizzle SQL migration files
│   ├── 001_init.sql
│   ├── 002_add_motion.sql
│   └── ...
├── scripts/
│   ├── install.sh                      # bootstrap script
│   ├── update.sh                       # OTA app update (with lockfile)
│   ├── system-update.sh                # system deps update (admin-triggered)
│   └── setup-wizard/                   # standalone Node HTTP server
│       └── index.ts
├── locales/
│   └── en.ts                           # all bot strings externalized
├── config/
│   ├── system-deps.yml                 # expected versions of 3rd party software
│   └── defaults.yml                    # default system configuration values
├── .env.example
├── .gitignore                          # includes .env
├── ecosystem.config.js                 # PM2 config
├── drizzle.config.ts
├── tsconfig.json
├── package.json
└── README.md
```

---

## 6. Configuration Defaults

### 6.1 Environment Variables (`.env`)

```bash
# Required
TELEGRAM_BOT_TOKEN=
DATABASE_PATH=/opt/home-worker/data/worker.db

# Display
TIMEZONE=Europe/Kyiv
DATE_FORMAT=DD.MM.YYYY              # Ukrainian format
TIME_FORMAT=HH:mm:ss               # 24-hour
DATETIME_FORMAT=DD.MM.YYYY HH:mm   # for bot messages

# Heartbeat
HEARTBEAT_URL=                      # UptimeRobot or similar, empty = disabled
HEARTBEAT_INTERVAL_MS=300000        # 5 minutes

# Retention
EVENT_RETENTION_DAYS=30
LOG_RETENTION_DAYS=30

# Sensor defaults
DEFAULT_DEBOUNCE_MS=10000
DEFAULT_SEVERITY=info

# CO2 defaults
CO2_READ_INTERVAL_MS=5000
CO2_FLUSH_INTERVAL_MS=60000
CO2_WARNING_PPM=800
CO2_CRITICAL_PPM=1200

# Motion / Camera
MOTION_VIDEO_SEGMENT_SEC=30
MOTION_LOCAL_DIR=/var/lib/motion

# Google Drive
GDRIVE_REMOTE_NAME=gdrive
GDRIVE_REMOTE_PATH=home-security/motion
GDRIVE_CLEANUP_MIN_AGE_DAYS=30

# Cleanup thresholds
DISK_WARN_PERCENT=70
DISK_CRITICAL_PERCENT=80
DISK_EMERGENCY_PERCENT=95
GDRIVE_CLEANUP_PERCENT=80

# Backup
BACKUP_CRON=0 3 * * *              # daily at 3 AM
BACKUP_LOCAL_PATH=/opt/home-worker/data/backup.db
BACKUP_TO_GDRIVE=true

# rclone
RCLONE_BW_LIMIT=1M
RCLONE_TRANSFERS=2

# PM2
PM2_MAX_MEMORY_RESTART=512M
PM2_MAX_RESTARTS=10
```

### 6.2 Defaults Config File (`config/defaults.yml`)

```yaml
# Sensor type defaults
sensor_defaults:
  digital:
    debounce_ms: 10000
    severity: info
    pull: up
    active_low: true
  uart:
    debounce_ms: 0
    severity: warning
    baud_rate: 9600
    read_interval_ms: 5000
    flush_interval_ms: 60000
  mqtt:
    debounce_ms: 5000
    severity: info
  camera:
    debounce_ms: 0
    severity: info
    snapshot_cache_ttl_ms: 2000

# Notification defaults
notifications:
  quiet_hours_default: null          # no quiet hours by default
  critical_ignores_quiet_hours: true
  max_queue_before_force_aggregate: 100
```

---

## 7. Database Schema (Drizzle)

### 7.1 Schema Definitions

```typescript
// src/database/schema.ts
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ─── Sensors ───

export const sensors = sqliteTable('sensors', {
  id:          text('id').primaryKey(),             // auto-generated, immutable
  name:        text('name').notNull().unique(),     // display name, changeable
  type:        text('type').notNull(),              // 'digital' | 'uart' | 'mqtt' | 'camera'
  config:      text('config', { mode: 'json' }),    // driver-specific config (pin, baud, topic, etc.)
  enabled:     integer('enabled', { mode: 'boolean' }).default(true),
  debounceMs:  integer('debounce_ms').default(10000),
  severity:    text('severity').default('info'),    // 'info' | 'warning' | 'critical'
  lastValue:   text('last_value'),                  // JSON-encoded current value
  lastValueAt: integer('last_value_at', { mode: 'timestamp' }),
  createdAt:   integer('created_at', { mode: 'timestamp' }),
  updatedAt:   integer('updated_at', { mode: 'timestamp' }),
});

// ─── Sensors Archive (soft-deleted sensors) ───

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

// ─── Events (state transitions, notification queue) ───

export const events = sqliteTable('events', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  sensorId:  text('sensor_id'),                     // references sensors.id or sensorsArchive.id
  type:      text('type').notNull(),                 // 'state_change' | 'threshold' | 'motion' | 'system'
  payload:   text('payload', { mode: 'json' }),      // { oldValue, newValue, ... }
  createdAt: integer('created_at', { mode: 'timestamp' }),
  sentAt:    integer('sent_at', { mode: 'timestamp' }),  // NULL = unsent
}, (table) => [
  index('idx_events_unsent').on(table.sentAt),
  index('idx_events_sensor_time').on(table.sensorId, table.createdAt),
]);

// ─── Sensor Logs ───

export const sensorLogs = sqliteTable('sensor_logs', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  sensorId:  text('sensor_id'),
  level:     text('level').notNull(),             // 'debug' | 'info' | 'warn' | 'error'
  message:   text('message').notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }),
}, (table) => [
  index('idx_sensor_logs_sensor_time').on(table.sensorId, table.timestamp),
]);

// ─── Users ───

export const users = sqliteTable('users', {
  telegramId: integer('telegram_id').primaryKey(),
  name:       text('name').notNull(),
  role:       text('role').notNull().default('user'), // 'admin' | 'user'
  muted:      integer('muted', { mode: 'boolean' }).default(false),
  quietStart: text('quiet_start'),                // HH:MM format, null = no quiet hours
  quietEnd:   text('quiet_end'),                  // HH:MM format
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
  id:        text('id').primaryKey(),
  name:      text('name').notNull().unique(),
  type:      text('type').notNull(),              // 'motion' | 'rtsp' | 'neobox'
  config:    text('config', { mode: 'json' }),
  enabled:   integer('enabled', { mode: 'boolean' }).default(true),
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
  name:         text('name').primaryKey(),         // 'digital' | 'uart' | 'zigbee' | 'motion' | 'neobox' | '4g'
  enabled:      integer('enabled', { mode: 'boolean' }).default(false),
  installed:    integer('installed', { mode: 'boolean' }).default(false), // deps present on disk
  config:       text('config', { mode: 'json' }),
});

// ─── System Metadata ───

export const systemMeta = sqliteTable('system_meta', {
  key:   text('key').primaryKey(),
  value: text('value'),
});
// Used for: 'schema_version', 'last_boot', 'last_shutdown_reason', etc.
```

### 7.2 Sensor Deletion Flow

When a sensor is removed via `/config remove`:

1. Sensor driver is destroyed
2. Sensor row is moved from `sensors` to `sensors_archive` (INSERT + DELETE in transaction)
3. Existing events and logs retain `sensor_id` — they reference the archive
4. `/logs <archived_sensor>` still works (queries both tables for name resolution)
5. GPIO pin becomes available for re-use

Queries against `sensors` table are always clean — no `WHERE deleted = false` needed anywhere.

### 7.3 Migration Strategy

- Drizzle Kit generates SQL migration files in `migrations/`
- On startup, worker checks current schema version from `system_meta` and applies pending migrations
- Migrations are plain SQL files — inspectable, version-controlled
- OTA update script runs migrations before restarting PM2
- **Migrations must be backward-compatible** — the old code version should still work with the new schema in case of rollback

### 7.4 Retention Policies

| Table | Retention | Mechanism |
|-------|-----------|-----------|
| `events` (sent) | 30 days (configurable via `EVENT_RETENTION_DAYS`) | NestJS cron scheduler, daily prune |
| `events` (unsent) | Infinite | Never pruned until sent |
| `sensor_logs` | 30 days (configurable via `LOG_RETENTION_DAYS`) | NestJS cron scheduler, daily prune |
| `motion_events` | Infinite in DB | Rows kept, local files cleaned by CleanupService |
| PM2 logs | Managed by pm2-logrotate | Auto |

### 7.5 Write Optimization for SD Card

- SQLite WAL mode reduces write amplification
- `PRAGMA synchronous=NORMAL` (not FULL) — acceptable tradeoff for performance
- `PRAGMA busy_timeout=5000` — prevents SQLITE_BUSY when rclone causes I/O contention
- CO2 readings: buffer in memory, flush to DB every 60 seconds
- Sensor events (digital): write immediately (low frequency, ~20/day)
- Mount `/tmp` and `/var/log` as tmpfs to reduce non-essential SD writes

### 7.6 Database Backup

- Daily backup via SQLite Online Backup API (not `VACUUM INTO` — allows concurrent reads/writes during backup)
- Scheduled at 3 AM (configurable via `BACKUP_CRON`) — low-activity window
- Local backup: `/opt/home-worker/data/backup.db` (survives DB corruption, same SD card)
- Remote backup: rclone upload to Google Drive `gdrive:home-security/backups/worker-YYYY-MM-DD.db`
- Retention: keep last 7 backups on Drive, delete older
- On corruption (detected by `PRAGMA integrity_check` on boot): attempt recovery from local backup, notify admin

---

## 8. Sensor Architecture

### 8.1 Driver Interface

```typescript
// src/sensors/sensor.interface.ts

export interface SensorConfig {
  id: string;
  name: string;
  type: string;
  config: Record<string, any>;
  debounceMs: number;
  severity: 'info' | 'warning' | 'critical';
}

export interface SensorReading {
  value: string | number | boolean;
  timestamp: Date;
  raw?: any;
}

export interface ISensorDriver {
  init(config: SensorConfig): Promise<void>;
  destroy(): Promise<void>;
  getState(): SensorReading;
  onEvent(callback: (event: SensorEvent) => void): void;
  healthCheck(): Promise<boolean>;
}

export interface SensorEvent {
  sensorId: string;
  type: 'state_change' | 'threshold' | 'error';
  oldValue?: any;
  newValue: any;
  timestamp: Date;
}
```

### 8.2 Drivers

#### Digital (GPIO)

- Uses `pigpio` npm in socket mode (connects to pigpiod daemon)
- Configurable: pin number, active high/low, pull-up/pull-down
- Debounce handled at driver level (configurable per sensor)
- Health check: verify pin is readable
- **Pin uniqueness validated on config add/import — rejects duplicate GPIO pins**

```typescript
// Example sensor config in SQLite
{
  "pin": 17,
  "activeLow": true,
  "pull": "up"      // "up" | "down" | "none"
}
```

#### UART (CO2)

- Uses `serialport` npm
- Read interval: every 5 seconds in memory, flush to DB every 60 seconds
- Threshold events: 800ppm (warning), 1200ppm (critical) — configurable via `.env`
- `/status` shows current PPM value + level (normal/warning/critical)
- Health check: verify serial port responds
- Readings validated against sane range (0-5000ppm), outliers discarded, warning logged after N consecutive bad reads

```typescript
// Example sensor config in SQLite
{
  "port": "/dev/serial0",
  "baudRate": 9600,
  "thresholds": {
    "warning": 800,
    "critical": 1200
  }
}
```

#### MQTT (Zigbee — future)

- Subscribes to Zigbee2MQTT topics
- Each Zigbee device maps to a sensor in the registry
- Config stores MQTT topic and expected payload format

#### Camera (RTSP/Neobox — future)

- Snapshot via ffmpeg: `ffmpeg -i rtsp://... -frames:v 1 snapshot.jpg`
- Snapshot cache: 2-second TTL to prevent concurrent ffmpeg spawns
- Concurrent requests return cached snapshot

### 8.3 Sensor Registry

- Backed by SQLite `sensors` table
- Loaded into memory on startup (including `lastValue` for immediate `/status` response)
- Hot-reload: when sensor config changes in DB (via bot command), registry diffs and applies changes
  - New sensors: init driver
  - Removed sensors: destroy driver, move to `sensors_archive`
  - Changed sensors: destroy old driver, init new driver
- Config changes queued and applied between processing cycles (not mid-event)

### 8.4 Sensor State vs Events

Two separate concepts tracked explicitly:

- **State** (`sensors.lastValue` + `sensors.lastValueAt`): current value right now. Updated on every reading. Used by `/status` command. Available immediately on boot without waiting for drivers to re-init.
- **Events** (`events` table): state transitions. Used for notifications, logs, offline queue.

### 8.5 Mock GPIO Driver (Development)

For development on non-Pi machines, a mock driver replaces pigpio:

```typescript
// src/sensors/drivers/mock.driver.ts
class MockGpioDriver implements ISensorDriver {
  private state = new Map<number, 0 | 1>();

  simulateChange(pin: number, value: 0 | 1) {
    this.state.set(pin, value);
    this.listeners.get(pin)?.(value);
  }
}
```

Selection based on environment:

```typescript
providers: [{
  provide: 'GPIO_DRIVER',
  useFactory: () =>
    process.env.NODE_ENV === 'development'
      ? new MockGpioDriver()
      : new PigpioDriver(),
}]
```

In dev mode, a web panel at `http://localhost:4000/dev/simulate` provides toggle buttons for each sensor to trigger state changes manually.

---

## 9. Event Queue

### 9.1 Delivery Guarantee

The event queue provides **at-least-once delivery**. An event is marked as sent only after the Telegram API returns HTTP 200. If the connection drops after Telegram receives the message but before the worker writes `sent_at` to SQLite, the event will be re-sent on the next drain cycle. **Duplicate notifications are acceptable; lost notifications are not.**

### 9.2 Offline Buffer

All sensor events are written to the `events` table with `sent_at = NULL`. The EventProcessor attempts to send them via Telegram. On success, `sent_at` is set. On failure (no internet), the event remains queued indefinitely.

### 9.3 Queue Drain on Reconnect

When connection restores after an outage, events are drained in batches:

```typescript
async drainQueue() {
  while (true) {
    const batch = db.select().from(events)
      .where(isNull(events.sentAt))
      .orderBy(events.createdAt)
      .limit(50);

    if (batch.length === 0) break;

    const summary = this.aggregateBatch(batch);
    await this.sendToTelegram(summary);
    this.markAsSent(batch);

    await sleep(2000); // respect Telegram rate limits
  }
}
```

### 9.4 Aggregated Summaries

Offline events are sent as chronological summaries preserving causal order:

```
📋 Offline events (05.04.2026 14:00 — 08.04.2026 09:30):

05.04.2026 14:23 — door_1 OPENED
05.04.2026 14:24 — water_1 TRIGGERED ⚠️
05.04.2026 14:25 — door_1 CLOSED
06.04.2026 08:00 — CO2 peak 1450ppm
... (12 more events)
```

Critical events (severity=critical) are highlighted. If the summary exceeds Telegram's 4096 character limit, it is split into multiple messages or sent as a file attachment.

### 9.5 Force Aggregation for Large Queues

If the unsent queue exceeds 100 events (configurable via `max_queue_before_force_aggregate`), the entire backlog is aggregated into a single summary file (sent as a Telegram document attachment), and all events are marked as sent. This prevents hours-long drip-feed after extended outages.

---

## 10. Telegram Bot

### 10.1 Library

grammY with the following plugins:
- `@grammyjs/runner` — auto-reconnect, handles network drops
- `@grammyjs/auto-retry` — respects Telegram rate limits (429 responses)
- `@grammyjs/conversations` — multi-step interactive flows (sensor config CRUD)

### 10.2 Polling Health

grammY's runner handles basic reconnection, but WiFi drops can leave half-open TCP sockets. Additional safeguards:

```typescript
// Explicit timeout on polling requests
bot.api.config.use((prev, method, payload) => {
  return prev(method, { ...payload, timeoutSeconds: 30 });
});

// NetworkService verifies bot health independently
// If no update received in 2 minutes, force-restart polling
```

### 10.3 Chat Architecture

- **Private chat only** for all interactions
- Config commands restricted to admin private chat
- Notifications sent to each user's private chat individually
- No group chat support (simplifies permission model)

### 10.4 Role Model

| Role | Capabilities |
|------|-------------|
| **Admin** | All commands, config, user management, updates, system health |
| **User** | `/status`, `/logs`, `/camera`, receive notifications |

### 10.5 Admin Claim Flow (First Boot)

1. Worker starts, checks `users` table — empty, no admin exists
2. Worker enters "awaiting admin" mode — indefinitely waits for first `/claim_admin` command
3. First user to send `/claim_admin` becomes admin
4. Worker logs the event, sends confirmation, disables the command permanently
5. Additional admins added via `/promote` by existing admin

No time window, no claim code. Simple and sufficient for a locally deployed system where only the owner knows the bot.

### 10.6 User Invite Flow

1. Admin sends `/invite`
2. Bot generates one-time invite code
3. Admin shares code with new user
4. New user sends `/start <code>` to bot
5. Bot registers user with `user` role
6. Code marked as used

### 10.7 Commands

#### All Users

| Command | Description |
|---------|-------------|
| `/start <invite_code>` | Register with invite code |
| `/status` | Current state of all sensors |
| `/logs <sensor> [count]` | Last N log entries for a sensor (default 20) |
| `/logs <sensor> --since 2h` | Logs since time offset |
| `/camera snapshot [name]` | Live snapshot (defaults to first camera) |
| `/camera events [date]` | Motion events with timestamps |
| `/camera video <event_id>` | Send video for specific motion event |
| `/camera photo <event_id>` | Send snapshot for specific motion event |
| `/mute <sensor>` | Mute notifications for a sensor |
| `/unmute <sensor>` | Unmute notifications for a sensor |
| `/quiet_hours HH:MM-HH:MM` | Set quiet hours (info suppressed, critical delivered) |
| `/quiet_hours off` | Disable quiet hours |
| `/ping` | Alive check with response time |
| `/help` | Role-aware command list |

#### Admin Only

| Command | Description |
|---------|-------------|
| `/config add` | Add sensor (conversational flow with inline keyboards) |
| `/config modify <sensor>` | Modify sensor |
| `/config remove <sensor>` | Archive sensor |
| `/export_config` | Download full config as YAML file |
| `/import_config` | Upload YAML file, validate, import into SQLite |
| `/invite` | Generate one-time invite code |
| `/promote <user>` | Promote user to admin |
| `/demote <user>` | Demote admin to user |
| `/update` | OTA app update (git pull + yarn install + pm2 restart) |
| `/rollback` | Revert to previous version |
| `/system_update` | Update system deps (shows diff, requires confirmation) |
| `/feature enable <n>` | Enable a pre-installed feature |
| `/feature disable <n>` | Disable feature |
| `/health` | System health report |
| `/gdrive status` | Google Drive sync health, quota, last upload |
| `/camera enable` | Start motion daemon |
| `/camera disable` | Stop motion daemon |
| `/restart` | Restart worker via PM2 |

### 10.8 `/status` Output Format

```
📊 System Status

🚪 front_door: CLOSED
🚪 back_door: OPEN ⚠️ (since 14:23)
💧 water_kitchen: OK
💧 water_bathroom: OK
🌬️ co2_living: 620 ppm ✅

📡 All systems online | 08.04.2026 14:35
```

Sensor icons are configurable per sensor type in the locale file. "Since" time shown for open/triggered states. If any sensor is offline, a warning line is appended.

### 10.9 `/health` Output Format

```
🏥 System Health

💾 Disk: 12.3 GB / 29.1 GB (42%)
🌡️ CPU Temp: 52°C
🧠 Memory: 312 MB / 1024 MB (30%)
⏱️ Uptime: 14d 6h 23m
📊 DB Size: 4.2 MB
📡 Bot: polling OK (last update 12s ago)
🔌 Sensors: 5/5 online
📁 Motion: 847 MB local, 2.3 GB on Drive
```

### 10.10 Automatic Notifications

| Event | Recipients | Respects Quiet Hours |
|-------|-----------|---------------------|
| Sensor state change | All users (minus muted) | Info: yes. Warning/Critical: no |
| System start (full status) | All users | No |
| Motion event (snapshot + timecode) | All users (minus muted) | Info: yes. Warning/Critical: no |
| Disk/sync warnings | Admins only | No |
| OTA update result | Admins only | No |
| Crash-loop detection | Admins only | No |
| External heartbeat failure | External service (not bot) | N/A |

### 10.11 Event Debounce

Configurable per sensor via `debounce_ms` field. Default: 10,000ms (configurable via `DEFAULT_DEBOUNCE_MS`).

Logic: debounce repeated identical state changes (e.g., door OPEN→OPEN), but always deliver actual state transitions (OPEN→CLOSE). Critical severity sensors (water) can be set to debounce=0.

### 10.12 Quiet Hours — Timezone

Quiet hours are evaluated in local time (`TIMEZONE` env var, default `Europe/Kyiv`), not UTC. DST transitions are handled automatically by the timezone library. Critical events always bypass quiet hours regardless of timezone.

### 10.13 Notification Language

English by default. All bot strings externalized in `locales/en.ts`. Easy to add translations by creating additional locale files.

### 10.14 Long Operations UX

Commands that take time (`/camera snapshot`, `/camera video`, `/update`) immediately reply with a status message and typing indicator (`ctx.replyWithChatAction('upload_photo')`), then edit/reply with the result. Prevents users from spamming the command.

### 10.15 Interrupted Conversations

If the bot restarts during a multi-step conversation (e.g., `/config add`), the conversation state is lost (grammY conversations are in-memory). On the user's next message, bot replies: "Previous operation was interrupted. Please start again." Conversation state is not persisted to SQLite — not worth the complexity.

---

## 11. Motion Camera Module

### 11.1 Motion Daemon

- Installed as a systemd service, independent of worker
- Worker controls it via passwordless sudo:

```bash
# /etc/sudoers.d/homeworker
homeworker ALL=(ALL) NOPASSWD: /bin/systemctl start motion, /bin/systemctl stop motion, /bin/systemctl restart motion
```

- Motion hooks call worker HTTP endpoints:

```
# motion.conf
on_event_start curl -s http://localhost:4000/motion/event-start?camera=%t
on_event_end curl -s http://localhost:4000/motion/event-end?camera=%t&file=%f
on_picture_save curl -s http://localhost:4000/motion/snapshot?file=%f
```

### 11.2 File Structure

```
/var/lib/motion/
├── 2026/
│   ├── 03/
│   │   └── 08/
│   │       ├── 125106.mp4
│   │       ├── 125106.jpg
│   │       ├── 130042.mp4
│   │       └── 130042.jpg
│   └── 04/
│       └── 08/
│           └── ...
```

Path format: `YYYY/MM/DD/HHMMSS.{mp4,jpg}`

Videos are cut into 30-second segments by motion configuration. The nested directory structure means cleanup deletes entire day-directories when all files within are uploaded and past retention age.

### 11.3 Google Drive Sync

- Uses `rclone copy` (one-way, additive — never `rclone sync`)
- Google Drive auth: service account (no OAuth token expiry)
- Upload flow: motion event ends → worker logs in SQLite → queues upload → rclone uploads per-file → marks `uploaded_to_gdrive = true` on success, retries on failure
- rclone spawned with `ionice -c3` for lowest I/O priority (prevents SQLite busy timeouts)

```bash
ionice -c3 rclone copy /var/lib/motion/ gdrive:home-security/motion/ \
  --min-age 1m \
  --transfers 2 \
  --bwlimit 1M
```

### 11.4 Cleanup — Local

- CleanupService runs on schedule (e.g., every hour)
- Checks disk usage via `df`
- If > 80% (`DISK_CRITICAL_PERCENT`): delete oldest local files WHERE `uploaded_to_gdrive = true`, clean empty day-directories
- Update SQLite: `local_deleted = true`
- **Critical rule:** never delete a file that hasn't been uploaded. If Drive sync is broken and disk fills up, alert via Telegram instead of losing footage.

### 11.5 Cleanup — Google Drive

- Free Google Drive quota: 15GB
- `/gdrive status` reports remaining space
- When Drive > 80% full (`GDRIVE_CLEANUP_PERCENT`): delete oldest files on Drive (minimum 30 days retention, configurable via `GDRIVE_CLEANUP_MIN_AGE_DAYS`)
- Update SQLite: `gdrive_file_id = null`

### 11.6 Video Delivery via Telegram

Telegram file limit: 50MB. With 30-second clips at 720p, most files will be under this. If a video exceeds 50MB:
- Compress with ffmpeg (lower bitrate) before sending
- If still over limit, send Google Drive link instead

### 11.7 Snapshot Concurrency

```typescript
// SnapshotService
async getSnapshot(cameraId: string): Promise<Buffer> {
  if (this.cache.has(cameraId) && this.cache.get(cameraId).age < 2000) {
    return this.cache.get(cameraId).data;
  }
  const frame = await this.grabFrame(cameraId); // ffmpeg
  this.cache.set(cameraId, { data: frame, age: Date.now() });
  return frame;
}
```

Multiple concurrent `/camera snapshot` requests return the cached frame. No concurrent ffmpeg spawns.

### 11.8 Multiple Cameras

Schema supports multiple cameras from day one. Bot commands default to first/only camera if name is omitted: `/camera snapshot` vs `/camera snapshot front_door`.

---

## 12. Config Management

### 12.1 Source of Truth

SQLite is the runtime source of truth for all configuration (sensors, users, features, cameras).

### 12.2 YAML as Import/Export

YAML is a portable format for backup, migration, and disaster recovery:

- `/export_config` → generates YAML file, sends via Telegram
- `/import_config` → user uploads YAML, bot validates schema, loads into SQLite
- Disaster recovery flow: flash new Pi → install → import YAML → running

### 12.3 YAML Schema Validation

On `/import_config`, the uploaded YAML is validated before any DB writes:

**Validation rules:**
- Required fields present per sensor type (`pin` for digital, `port` for UART, etc.)
- GPIO pin numbers within valid range (0-27 for Pi)
- No duplicate GPIO pins across sensors
- No duplicate sensor names
- Severity values are valid enum (`info` | `warning` | `critical`)
- UART baud rates are valid standard values
- Thresholds are numeric and min < max
- Camera types are valid enum

**On validation failure:**
- Bot replies with specific errors: "Line 12: sensor 'door_3' has invalid pin number 99" or "Sensors 'door_1' and 'window_2' both use GPIO pin 17"
- No changes written to DB
- User can fix and re-upload

**On validation success with conflicts:**
- Bot shows summary: "3 sensors will be added, 2 will be updated, 1 will be archived (door_old not in import)"
- Admin confirms via inline keyboard: `[Apply] [Cancel]`
- On apply: transaction wraps all changes

### 12.4 Sensor Config via Bot

Conversational flow using grammY `conversations` plugin with inline keyboards:

```
Admin: /config add
Bot: What type of sensor?
     [Digital] [UART] [MQTT] [Camera]
Admin: [Digital]
Bot: Sensor name?
Admin: front_door
Bot: GPIO pin number?
Admin: 17
Bot: Active high or low?
     [Active High] [Active Low]
Admin: [Active Low]
Bot: Pull resistor?
     [Pull Up] [Pull Down] [None]
Admin: [Pull Up]
Bot: Severity level?
     [Info] [Warning] [Critical]
Admin: [Info]
Bot: ✅ Sensor "front_door" added (GPIO 17, active low, pull up, info)
```

**Validation during conversational flow:**
- GPIO pin checked for uniqueness immediately after entry
- Invalid values prompt re-entry with error message

### 12.5 Hot-Reload Flow

1. Bot command modifies SQLite
2. SensorRegistry detects change (polling or event-driven)
3. Diffs current in-memory state vs DB
4. Tears down removed/changed drivers
5. Initializes new/changed drivers
6. **Changes queued and applied between event processing cycles** (not mid-event, prevents race conditions)

---

## 13. Network & Reliability

### 13.1 NetworkService

```typescript
class NetworkService {
  // Ping Telegram API every 30 seconds
  async healthCheck(): Promise<boolean>;

  // Verify bot is actually receiving updates (not just internet up)
  isBotPollingHealthy(): boolean;

  // Future: 4G failover
  async switchTo4G(): Promise<void>;
  async switchToWifi(): Promise<void>;
}
```

### 13.2 External Heartbeat

Worker sends HTTP GET to external monitoring service every 5 minutes (configurable via `HEARTBEAT_INTERVAL_MS`). Service alerts via email/SMS if pings stop. This detects scenarios invisible to the bot: kernel panic, SD card failure, power loss beyond UPS capacity, network hardware failure.

**Included in Phase 0.**

### 13.3 Hardware Watchdog (optional)

Pi has a built-in hardware watchdog (`bcm2835_wdt`). If the worker process doesn't "pet" it every N seconds, the Pi automatically reboots. Cheap insurance against kernel panics or complete system freezes.

### 13.4 Graceful Shutdown

Shutdown sequence is **explicit and ordered**. NestJS `onModuleDestroy` hooks alone are not sufficient — the order must be controlled across modules:

1. Set `shuttingDown = true` flag (all modules check this)
2. Stop accepting new sensor events (SensorRegistry stops polling/callbacks)
3. Wait for any in-flight event processing to complete (max 5s timeout)
4. Flush pending DB writes (CO2 memory buffer, any batched operations)
5. Send "system going offline" notification to Telegram (await delivery)
6. Close bot polling connection
7. Close SQLite database

**On `/restart` command specifically:** before step 1, store `restart_reason: 'user_command'` in `system_meta`. On boot, check this flag and send "Restart complete" notification. Clear the flag. This distinguishes user-triggered restarts from crashes.

### 13.5 Boot Recovery

On startup:

1. Write PID to lockfile (`/tmp/home-worker.lock`). If lockfile exists and process alive, refuse to start.
2. Run `PRAGMA integrity_check` on SQLite — if corrupt, attempt recovery from local backup, notify admin
3. Check `system_meta` for `restart_reason` — send appropriate notification
4. Detect and mark truncated motion video files (power loss during recording)
5. Send "system online" notification with full sensor status
6. Start all sensor drivers
7. Drain unsent event queue

### 13.6 Duplicate Instance Prevention

On startup, worker writes its PID to `/tmp/home-worker.lock`. Before writing, it checks if the lockfile exists and if the PID inside it corresponds to a running process. If so, the worker logs an error and refuses to start. PM2 `instances: 1` provides additional protection. The lockfile is deleted on graceful shutdown.

---

## 14. Error Handling

### 14.1 General Principles

- Every bot command has an error response: "❌ Failed to [action]: [reason]"
- Every external service (pigpiod, motion, rclone, Telegram API) has a health status tracked in memory
- If a service is down, related commands return a clear error instead of crashing
- **No unhandled exception should ever crash the process** — catch at command handler and service level
- Errors logged to `sensor_logs` (for sensor-related) or stdout/PM2 logs (for system-related)

### 14.2 pigpiod Unavailable

- **On startup:** worker detects pigpiod unreachable, logs error, starts bot without sensors, sends admin notification "⚠️ pigpiod is not running, sensor monitoring disabled"
- **Mid-runtime:** driver `healthCheck()` fails, sensor marked as `offline`, admin notified
- **`/status` shows:** `🚪 front_door: ⚠️ OFFLINE (driver error)`
- Bot commands still work, just no sensor data

### 14.3 Telegram API Unreachable

- Events keep writing to SQLite queue (offline buffer works)
- NetworkService detects outage, stops retry spam
- On reconnect: drain queue with aggregated summary
- grammY `auto-retry` plugin handles transient 429/5xx errors automatically

### 14.4 rclone / Google Drive Failure

- Individual file marked as not uploaded, retried on next cycle
- After 5 consecutive failures: admin notified "⚠️ Google Drive sync failing: [error]"
- Files never deleted locally if not uploaded (critical safety rule)
- `/gdrive status` shows error state

### 14.5 SQLite Corruption on Boot

- `PRAGMA integrity_check` detects issue
- Attempt recovery from local backup (`backup.db`)
- If backup exists: rename corrupt DB, restore from backup, notify admin "⚠️ Database was recovered from backup"
- If no backup: rename corrupt DB, create fresh DB, notify admin "⚠️ Database was reset, use /import_config to restore"

### 14.6 Disk Full

Prevention and response at multiple thresholds:

| Threshold | Action |
|-----------|--------|
| 70% (`DISK_WARN_PERCENT`) | Admin notified: "⚠️ Disk usage at 70%" |
| 80% (`DISK_CRITICAL_PERCENT`) | CleanupService aggressively deletes uploaded motion files |
| 95% (`DISK_EMERGENCY_PERCENT`) | **Emergency mode:** prune sent events older than 1 day, prune sensor_logs older than 1 day, stop motion daemon, notify admin "🚨 Emergency disk cleanup triggered" |

Worker catches `ENOSPC` on every write operation and degrades gracefully instead of crashing.

### 14.7 Motion Daemon Crash

- Worker detects via `systemctl is-active motion`
- Attempts restart (up to 3 times with backoff)
- If persistent failure: admin notified, motion feature marked as degraded
- `/camera status` shows: "❌ Motion daemon is not running"

### 14.8 Bot Command Failure

- Catch at command handler level (never propagate to process)
- Reply to user: "❌ Failed to [action]: [reason]"
- Log full error with stack trace to PM2 logs

### 14.9 OTA Update Failure

- `yarn install` fails: rollback to previous commit, notify admin via bot (or curl to Telegram API if worker is dead)
- Migration fails: rollback commit + notify (migrations must be backward-compatible to minimize this risk)
- **Health check:** after restart, worker must stay alive for 30 seconds. If it crashes within 30 seconds, the update script detects this (polls PM2 status), rolls back, and notifies admin

### 14.10 Memory Pressure

- PM2 configured with `max_memory_restart: '512M'` — auto-restart if memory exceeds threshold
- `/health` reports current memory usage so admin can spot trends (gradual leak)
- On PM2 memory-triggered restart: worker logs the event, treated as a crash restart (no "user_command" flag)

### 14.11 Clock Drift (No RTC, No Internet)

- On boot without NTP sync, system clock may be wrong
- Worker logs system event: "⚠️ Clock not synchronized" with current (possibly wrong) time
- After NTP syncs, worker logs: "✅ Clock synchronized, offset was Xms"
- Timestamps logged before NTP sync are not retroactively corrected — the gap is visible in logs

### 14.12 Concurrent `/update` Prevention

Update script uses a lockfile (`/tmp/home-worker-updating.lock`):

```bash
LOCKFILE="/tmp/home-worker-updating.lock"
if [ -f "$LOCKFILE" ]; then
  echo "Update already in progress"
  exit 1
fi
touch "$LOCKFILE"
trap "rm -f $LOCKFILE" EXIT
# ... update logic ...
```

Bot checks for lockfile before triggering update and replies: "Update already in progress, please wait."

---

## 15. OTA Updates

### 15.1 App Update (`/update`)

```bash
#!/bin/bash
# scripts/update.sh
set -euo pipefail

LOCKFILE="/tmp/home-worker-updating.lock"
if [ -f "$LOCKFILE" ]; then
  echo "Update already in progress"
  exit 1
fi
touch "$LOCKFILE"
trap "rm -f $LOCKFILE" EXIT

cd /opt/home-worker
PREV_COMMIT=$(git rev-parse HEAD)
git fetch origin main

REMOTE=$(git rev-parse origin/main)
if [ "$PREV_COMMIT" = "$REMOTE" ]; then
  echo "Already up to date"
  exit 0
fi

git tag "rollback-$(date +%s)" "$PREV_COMMIT"
git reset --hard origin/main
corepack yarn install --immutable

# Run DB migrations
corepack yarn db:migrate

# Restart and verify health (must survive 30 seconds)
pm2 restart worker

sleep 30
if ! pm2 show worker | grep -q "online"; then
  echo "Health check failed, rolling back"
  git reset --hard "$PREV_COMMIT"
  corepack yarn install --immutable
  pm2 restart worker
  # Notify admin via direct curl (worker may be unstable)
  curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${ADMIN_TELEGRAM_ID}" \
    -d "text=⚠️ Update failed health check. Rolled back to previous version."
  exit 1
fi
```

Triggered by: `/update` bot command (admin only) or optional hourly cron check.

### 15.2 Rollback (`/rollback`)

```bash
PREV=$(git tag --list 'rollback-*' --sort=-creatordate | head -1)
git reset --hard "$PREV"
corepack yarn install --immutable
pm2 restart worker
```

### 15.3 System Update (`/system_update`)

Separate from app updates. Admin-triggered only. Shows diff before applying:

```
Bot: System update available:
  • motion: 4.5.1 → 4.6.0
  • rclone: 1.65 → 1.67
  • ffmpeg: no update
  • node: 20.11 → 20.14 (minor)

Proceed? [Yes] [Cancel]
```

System deps defined in `config/system-deps.yml`:

```yaml
node: "20"
motion: "latest"
rclone: "latest"
ffmpeg: "latest"
mosquitto: "latest"
```

Update script snapshots current state, applies updates, runs 30-second health check. On failure, notifies admin via direct Telegram API call (curl, since worker may be dead).

**Node.js major version upgrades** are never automatic — they require native module recompilation and can break things. Only minor/patch versions are auto-upgraded.

### 15.4 Crash-Loop Detection

PM2 configured with `max_restarts: 10`. After 10 consecutive crash restarts, PM2 stops trying. The external heartbeat (UptimeRobot) detects this and alerts. Additionally, the update script sends failure notifications directly via Telegram API (curl) if the worker can't start.

---

## 16. Installation

### 16.1 Phase 0 — Simple Install Script

```bash
curl -sSL https://raw.githubusercontent.com/<user>/<repo>/main/scripts/install.sh | bash
```

Script is idempotent (safe to re-run). Each function checks current state before acting.

Key steps:
1. Validate running on Raspberry Pi
2. Install system deps: `git`, `sqlite3`, `pigpio`, `ffmpeg`, `pm2`, `pm2-logrotate`
3. Install Node.js 20 (via nodesource)
4. Enable and start pigpiod
5. Clone repo to `/opt/home-worker`
6. `corepack yarn install --immutable`
7. Create `homeworker` system user
8. Prompt for Telegram bot token
9. Write `.env` with defaults from `.env.example`
10. Run DB migrations
11. Configure PM2 + systemd autostart (instances: 1, max_memory_restart: 512M, max_restarts: 10)
12. Mount `/tmp` and `/var/log` as tmpfs (add to `/etc/fstab`)
13. Start worker
14. Print: "Bot is running. Send /claim_admin to your bot to become admin."

### 16.2 Phase 1 — Setup Web Wizard

Replaces terminal prompts with a web interface:

1. Install script runs unattended (no prompts)
2. Starts a standalone lightweight HTTP server on `:3000` (not NestJS — separate 50-line script)
3. Wizard steps:
   - Step 1: Telegram bot token (validates via Telegram `getMe` API)
   - Step 2: Feature selection checkboxes (Digital, UART, Zigbee, Motion, Neobox, 4G)
   - Step 3: Feature-specific config (only for selected features — e.g., rclone auth for Motion)
4. Wizard writes `.env` + `features.json`, triggers feature dep installation
5. Wizard starts NestJS worker, then shuts itself down
6. Setup page displays: "Bot is running. Send /claim_admin to your bot."

### 16.3 Feature Installation

Each feature maps to system deps and npm packages. Features are installed at install-time (via wizard or install script). The bot command `/feature enable/disable` only toggles features whose deps are already installed — it does not install deps at runtime.

To install new feature deps after initial setup: re-run the install script with updated feature selection, or SSH in and run the feature install function manually.

```bash
install_feature() {
  case $1 in
    motion)
      sudo apt-get install -y motion
      mkdir -p /var/lib/motion
      install_rclone
      ;;
    zigbee)
      install_zigbee2mqtt
      install_mosquitto
      ;;
    uart)
      enable_serial_port
      ;;
  esac
}
```

---

## 17. Neobox Intercom (Investigation Required)

Integration depends on the exact model. Possible approaches (ranked by feasibility):

1. **RTSP stream** — scan device with `nmap` for RTSP port. If available, snapshot via ffmpeg.
2. **ONVIF** — test with ONVIF discovery tool. Some rebranded Chinese intercoms support it.
3. **Tuya local API** — if Tuya-based, reverse-engineered local APIs exist.
4. **SIP integration** — some video intercoms use SIP. Register as SIP client, capture frames.
5. **Cloud API / webhook** — last resort.

**Action item:** determine exact model number to evaluate options.

---

## 18. Flow Engine (Future)

### 18.1 Phase 2 — Simple Rules

Trigger → Action model:

```typescript
interface FlowRule {
  trigger: {
    sensorId: string;
    condition: 'state_change' | 'threshold_exceeded' | 'value_equals';
    value?: any;
  };
  action: {
    type: 'notify' | 'call_phone' | 'toggle_sensor' | 'webhook';
    config: Record<string, any>;
  };
}
```

Example: water sensor triggers → call phone number.

### 18.2 Future — Conditional Chains

Expandable to: if X AND Y within Z minutes → do A then B. Timers, scenes, conditional logic. Architecture should support this but implementation is deferred.

---

## 19. Timezone & Display Formatting

- **Storage:** all timestamps in UTC (SQLite integer timestamps)
- **Display timezone:** configured via `TIMEZONE` env var, default `Europe/Kyiv`
- **Date format:** configured via `DATE_FORMAT` env var, default `DD.MM.YYYY` (Ukrainian)
- **Time format:** configured via `TIME_FORMAT` env var, default `HH:mm:ss` (24-hour)
- **Bot message datetime:** configured via `DATETIME_FORMAT` env var, default `DD.MM.YYYY HH:mm`
- **Quiet hours:** evaluated in local time (respects DST automatically)
- **Motion daemon:** explicitly configured with timezone in `motion.conf`
- **RTC module:** recommended (DS3231) to prevent clock drift during offline periods

All format strings defined in `.env`, referenced in the locale file, consistent across all bot output.

---

## 20. Security Considerations

### 20.1 Process Isolation

- Worker runs as `homeworker` system user (non-root)
- pigpiod runs as root (systemd service)
- Worker connects to pigpiod via socket (no root needed)
- Motion runs as its own user (systemd service)
- Worker controls motion via passwordless sudo (limited commands only)

### 20.2 Secrets

- Bot token and service account key stored in `.env` (chmod 600, owned by homeworker)
- `.env` in `.gitignore` with pre-commit hook to reject accidental commits
- `.env.example` in repo with placeholder values

### 20.3 Bot Security

- First `/claim_admin` becomes admin (one-time, permanently disabled after)
- Invite codes are one-time use
- All commands check user role via RoleGuard middleware
- Unregistered users are ignored (bot does not respond)

### 20.4 Single Instance Constraint

SQLite with WAL mode supports one writer. **Never run multiple worker instances** (no PM2 cluster mode). Enforced by: PM2 `instances: 1`, PID lockfile on startup. Documented in README.

**Note:** splitting into separate processes (Phase 2) is fine — SQLite WAL supports multiple readers + one writer. Just ensure only one process does heavy writes.

---

## 21. Monitoring

### 21.1 External Heartbeat

Worker sends HTTP GET to external monitoring service every 5 minutes. Service alerts via email/SMS if pings stop. This detects scenarios invisible to the bot: kernel panic, SD card failure, power loss beyond UPS capacity, network hardware failure.

**Included in Phase 0.**

### 21.2 Hardware Watchdog (optional)

Pi has a built-in hardware watchdog (`bcm2835_wdt`). If the worker process doesn't "pet" it every N seconds, the Pi automatically reboots.

### 21.3 Crash-Loop Protection

PM2 `max_restarts: 10` prevents infinite restart loops. `max_memory_restart: 512M` prevents OOM. External heartbeat detects the resulting downtime.

---

## 22. Development Workflow

### 22.1 Dev Environment

- Run on any machine (Mac/Linux/Windows with WSL)
- `NODE_ENV=development` activates MockGpioDriver
- Dev simulator web panel at `http://localhost:4000/dev/simulate` with toggle buttons per sensor
- SQLite runs natively (no Pi needed)
- grammY connects to real Telegram API (use a separate test bot token)
- Motion integration: skip or mock (no camera in dev)

### 22.2 Testing Strategy

Minimum required tests:

| Area | Test Type | Description |
|------|-----------|-------------|
| Sensor driver contract | Unit | Each driver implements `init`, `destroy`, `getState`, `onEvent` correctly |
| Event queue drain | Integration | Insert 1000 events → drain → verify all sent with rate limiting |
| Config hot-reload | Integration | Modify SQLite → verify sensors update without restart |
| Bot commands | Integration | grammY test framework — verify responses and role guards |
| Aggregation | Unit | Offline events → aggregated summary with correct chronological order |
| DB migrations | Integration | Apply all migrations to empty DB → verify schema |
| YAML validation | Unit | Valid and invalid YAML files → verify correct acceptance/rejection |
| Pin uniqueness | Unit | Duplicate GPIO pins → verify rejection |

---

## 23. Open Items

| Item | Status | Blocker For |
|------|--------|-------------|
| Neobox exact model number | Needs investigation | Camera integration (Phase 2) |
| 4G modem model selection | Deferred | 4G failover (Phase 2) |
| MQTT as internal event bus vs direct in-process events | Deferred decision | Zigbee integration (Phase 2) |
| Sensor failure detection (floating GPIO, unresponsive UART) | Noted, deferred | Phase 2 |
| Process separation (critical vs non-critical) | Deferred | Phase 2 |
