# Docs Index — Token-Efficient Routing

Use this file to decide **which** `docs/*.md` to load. Each doc declares its own `## Dependencies` block at the top — follow those transitively only when needed.

## Task → Docs

| Task | Load (in order) |
|---|---|
| Project orientation / env vars / phases | 00 |
| Database schema / migrations / pragmas | 01 |
| Add or modify any sensor | 02 + driver-specific (03 / 04) |
| Add a digital (GPIO) sensor | 02, 03 |
| Add a CO2 / UART sensor | 02, 04 |
| Event queue, batching, retention | 05 |
| Add or modify a Telegram command | 06 + matching `bot-cmd-*` doc |
| Permissions / roles / invite flow | 06, 11 |
| Mute / quiet hours | 06, 12, 19 |
| Notifications & aggregation | 19, 05 |
| Camera (motion, snapshot, video) | 20, 14 |
| Google Drive sync / cleanup | 21, 15 |
| OTA app update / rollback / restart | 24, 13 |
| OS-level system update | 18, 24 |
| Config import/export (YAML) | 16, 10 |
| Feature toggles | 17 |
| Network / Wi-Fi / connectivity checks | 22 |
| Reliability (heartbeat, lockfile, restart loop) | 23 |
| Install / first-boot / setup wizard | 25 |
| Local dev workflow (mock GPIO, fixtures) | 26 |
| Full system spec (background reading) | home-worker-spec.md |

## Doc Catalogue

| # | Title | Scope (one line) |
|---|---|---|
| [00](00-overview.md) | Overview | Stack, layout, env vars, phased delivery plan |
| [01](01-database.md) | Database | Drizzle schema, SQLite pragmas, migrations |
| [02](02-sensor-core.md) | Sensor Core | `SensorDriver` interface, registry, lifecycle |
| [03](03-sensor-digital.md) | Digital Sensor Driver | GPIO via pigpio socket, debounce, pull-up |
| [04](04-sensor-uart.md) | UART CO2 Sensor Driver | serialport, read/flush intervals, thresholds |
| [05](05-event-queue.md) | Event Queue | Offline buffer, batched drain, retention |
| [06](06-bot-core.md) | Bot Core | grammY setup, runner, command registration, guards |
| [07](07-bot-cmd-status.md) | `/status` `/ping` `/help` | Basic status + help commands |
| [08](08-bot-cmd-health.md) | `/health` | Disk, memory, sensor liveness report |
| [09](09-bot-cmd-logs.md) | `/logs` | Tail sensor logs + system logs |
| [10](10-bot-cmd-config.md) | `/config add\|modify\|remove` | Sensor CRUD via bot |
| [11](11-bot-cmd-users.md) | `/invite` `/promote` `/demote` `/start` | Role management, claim-admin |
| [12](12-bot-cmd-mute.md) | `/mute` `/unmute` `/quiet_hours` | Notification suppression |
| [13](13-bot-cmd-update.md) | `/update` `/rollback` `/restart` | App-level OTA control |
| [14](14-bot-cmd-camera.md) | `/camera` | Snapshot, record, on/off |
| [15](15-bot-cmd-gdrive.md) | `/gdrive status` | Drive quota / sync status report |
| [16](16-bot-cmd-config-yaml.md) | `/export_config` `/import_config` | YAML round-trip of sensor config |
| [17](17-bot-cmd-feature.md) | `/feature enable\|disable` | Feature-flag toggles |
| [18](18-bot-cmd-system-update.md) | `/system_update` | OS-level apt update flow |
| [19](19-bot-notifications.md) | Notifications | Severity routing, aggregation, quiet hours |
| [20](20-camera.md) | Camera Module | Motion daemon control, segments |
| [21](21-gdrive.md) | Google Drive Sync | rclone, service account, cleanup thresholds |
| [22](22-network.md) | Network | Wi-Fi state, connectivity probing |
| [23](23-reliability.md) | Reliability | Heartbeat, PID lock, watchdog, restart policy |
| [24](24-ota.md) | OTA Updates | Update mechanism, atomic swap, rollback |
| [25](25-install.md) | Installation | `install.sh`, systemd, pigpiod, motion |
| [26](26-dev.md) | Development Workflow | Local dev, mock GPIO, vitest, fixtures |
| [spec](home-worker-spec.md) | System Spec | Full requirements & background — load only when needed |

## Loading Rules for Agents

1. **Do not bulk-load `docs/`.** Always start from this index.
2. Follow each loaded doc's `## Dependencies` line — load those too if the task touches them.
3. For code-level questions, prefer reading the source files linked from [AGENTS.md](../AGENTS.md) over the docs.
4. The `spec` doc is the original full spec — only load it when the numbered docs are insufficient.
