# 00 — Overview

## Project

Home Worker — home automation and security monitoring system on Raspberry Pi with NestJS worker and Telegram chatbot.

## Hardware

| Component | Details |
|-----------|---------|
| Minimum platform | Raspberry Pi 3 (1GB RAM) |
| Current platform | Raspberry Pi 5 |
| OS | Raspbian (latest) |
| Power | UPS hat (graceful shutdown window) |
| Storage | SD card |
| RTC | DS3231 module recommended |
| GPIO daemon | pigpiod (root, worker connects via socket) |
| Future | USB Zigbee dongle, USB 4G modem |

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js 20 | LTS, pinned to major version |
| Framework | NestJS | |
| Database | SQLite via better-sqlite3 | WAL mode, synchronous=NORMAL, busy_timeout=5000 |
| ORM | Drizzle ORM | Lightweight, TypeScript-first |
| Telegram | grammY | `@grammyjs/runner`, `@grammyjs/auto-retry`, `@grammyjs/conversations` |
| Process manager | PM2 | pm2-logrotate, max_memory_restart=512M, instances=1 |
| GPIO | pigpio (socket mode) | Non-root via pigpiod |
| UART | serialport npm | CO2 sensor |
| Camera | Motion daemon | systemd, worker controls via sudo |
| Cloud sync | rclone | Google Drive, service account auth |

## Project Structure

```
repo/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── sensors/
│   │   ├── sensor.module.ts
│   │   ├── sensor.registry.ts
│   │   ├── sensor.interface.ts
│   │   └── drivers/
│   │       ├── digital.driver.ts
│   │       ├── uart.driver.ts
│   │       ├── mqtt.driver.ts
│   │       ├── camera.driver.ts
│   │       └── mock.driver.ts
│   ├── events/
│   │   ├── event.module.ts
│   │   ├── event.queue.ts
│   │   └── event.processor.ts
│   ├── telegram/
│   │   ├── bot.module.ts
│   │   ├── commands/
│   │   │   ├── status.command.ts
│   │   │   ├── logs.command.ts
│   │   │   ├── config.command.ts
│   │   │   ├── camera.command.ts
│   │   │   ├── update.command.ts
│   │   │   ├── users.command.ts
│   │   │   ├── health.command.ts
│   │   │   ├── help.command.ts
│   │   │   ├── ping.command.ts
│   │   │   ├── restart.command.ts
│   │   │   ├── mute.command.ts
│   │   │   ├── quiet-hours.command.ts
│   │   │   ├── export-config.command.ts
│   │   │   ├── import-config.command.ts
│   │   │   └── feature.command.ts
│   │   ├── guards/
│   │   │   └── role.guard.ts
│   │   └── flows/
│   │       └── flow.engine.ts
│   ├── camera/
│   │   ├── camera.module.ts
│   │   ├── motion.service.ts
│   │   ├── upload.service.ts
│   │   └── cleanup.service.ts
│   ├── network/
│   │   ├── network.module.ts
│   │   └── network.service.ts
│   ├── database/
│   │   ├── database.module.ts
│   │   ├── schema.ts
│   │   └── backup.service.ts
│   └── config/
│       └── config.loader.ts
├── migrations/
├── scripts/
│   ├── install.sh
│   ├── update.sh
│   ├── system-update.sh
│   └── setup-wizard/
│       └── index.ts
├── locales/
│   └── en.ts
├── config/
│   ├── system-deps.yml
│   └── defaults.yml
├── .env.example
├── .gitignore
├── ecosystem.config.js
├── drizzle.config.ts
├── tsconfig.json
├── package.json
└── README.md
```

## Environment Variables (`.env`)

```bash
# Required
TELEGRAM_BOT_TOKEN=
DATABASE_PATH=/opt/home-worker/data/worker.db

# Display
TIMEZONE=Europe/Kyiv
DATE_FORMAT=DD.MM.YYYY
TIME_FORMAT=HH:mm:ss
DATETIME_FORMAT=DD.MM.YYYY HH:mm

# Heartbeat
HEARTBEAT_URL=
HEARTBEAT_INTERVAL_MS=300000

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
BACKUP_CRON=0 3 * * *
BACKUP_LOCAL_PATH=/opt/home-worker/data/backup.db
BACKUP_TO_GDRIVE=true

# rclone
RCLONE_BW_LIMIT=1M
RCLONE_TRANSFERS=2

# PM2
PM2_MAX_MEMORY_RESTART=512M
PM2_MAX_RESTARTS=10
```

## Defaults Config (`config/defaults.yml`)

```yaml
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

notifications:
  quiet_hours_default: null
  critical_ignores_quiet_hours: true
  max_queue_before_force_aggregate: 100
```

## Phased Delivery

### Phase 0 — MVP
- NestJS + Drizzle + SQLite
- Digital sensor driver (pigpio via socket)
- grammY bot: `/status`, `/claim_admin`, notifications
- Event queue with offline buffer + batched drain
- PM2, simple install script, manual `.env`
- External heartbeat, mock GPIO, PID lockfile

### Phase 1 — Usable Product
- Setup web wizard, sensor CRUD via bot, role management
- CO2 UART driver, `/logs`, `/health`, `/help`, `/ping`, `/restart`
- OTA `/update` + `/rollback`
- Motion camera + Google Drive sync + cleanup
- DB backup to Drive, YAML import/export, feature toggles
- Mute, quiet hours, debounce

### Phase 2 — Extended
- Zigbee + MQTT, flow engine, 4G failover
- Neobox intercom, multi-camera, system update management
- Process separation

## Timezone & Display

- Storage: UTC integer timestamps
- Display: `TIMEZONE` env var, default `Europe/Kyiv`
- Date: `DD.MM.YYYY`, Time: `HH:mm:ss`, Datetime: `DD.MM.YYYY HH:mm`
- Quiet hours evaluated in local time (DST-safe)
- All format strings in `.env`, referenced in locale file
