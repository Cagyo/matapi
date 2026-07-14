# 07 — /status, /ping, /help Commands

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (sensors table)
- 02-sensor-core.md (sensor registry)

## /menu — Authoritative Home

### Access and opening behavior

Registered private-chat users run `/menu` to open a fresh authoritative Home.
Opening reserves a 60-second pending session, renders from persisted sensor
state and the cached health snapshot, sends a new Telegram message, CAS-promotes
that exact reservation, and then strips the previous keyboard best-effort. A
send failure leaves the prior Home authoritative; a lost promotion strips the
losing message keyboard best-effort. Home identity requires the current user,
private chat, callback message ID, 16-character 96-bit token, and revision.

`/menu` **never calls `SensorHealthPort.probe`**. It can therefore open without
waiting on hardware and initially reports unavailable/stale health from the
cache. Complete health is fresh for two minutes; missing, failed, timed-out,
partial, absent, stale, or enabled-ID-mismatched cache data cannot produce the
normal verdict. `Check now` first renders a checking view, performs the shared
single-flight bounded 5-second driver probe, caches its result, and renders
again only for the currently authoritative identity.

### Views and callbacks

Home has Home and Sensors views in Slice 2. In-place navigation first reserves
a pending revision, edits the exact active Telegram message, and CAS-promotes
the pending view. A callback bearing that pending revision may promote it only
when it is still the winning reservation; otherwise it is updating or stale
and cannot mutate. Failed edits abandon pending state and attempt a fresh Home;
all Telegram cleanup is best-effort while server-side session validation is the
correctness boundary. Close clears the active row first, then best-effort
replaces the message with localized closed copy.

Sensors are text rows, not sensor callbacks: eight enabled sensors per page,
ordered by normalized name then immutable ID. A page is clamped if the set
changed; the attention summary may update without moving the selected
alphabetical page. Callback data is `h:<token>:<revision>:<action>[:<page>]`,
with compact action codes and a 64-byte UTF-8 maximum. Stale/unknown callbacks
offer the stateless `ho` action to create a new Home rather than revive an old
message.

---

## /status

### Access
All users

### Syntax
```
/status
```

### Behavior
Query all sensors from registry (in-memory, includes `lastValue`). Format and send current state of every enabled sensor.

### Output Format
```
📊 System Status

🚪 front_door: CLOSED
🚪 back_door: OPEN ⚠️ (since 14:23)
💧 water_kitchen: OK
💧 water_bathroom: OK
🌬️ co2_living: 620 ppm ✅

📡 All systems online | 08.04.2026 14:35
```

- Icons configurable per sensor type in locale file
- "Since" time shown for open/triggered states (from `lastValueAt`)
- If any sensor is offline: append `⚠️ 1 sensor offline` warning line
- Timestamps in `DATETIME_FORMAT` from `.env`

### Edge Cases
- No sensors configured → "No sensors configured. Use /config to add sensors."
- All sensors offline → show all as offline + warning

### Error Cases
- DB read fails → "❌ Failed to read sensor status"

---

## /ping

### Access
All users

### Syntax
```
/ping
```

### Behavior
Reply immediately with response time.

### Output
```
🏓 Pong! (42ms)
```

Measure time from message receipt to reply send.

---

## /help

### Access
All users (output varies by role)

### Syntax
```
/help
```

### Behavior
Show available commands based on user's role.

### Output — User
```
📖 Available Commands

/status — Sensor status
/logs <sensor> [count] — Sensor logs
/camera snapshot — Live camera snapshot
/camera events [date] — Motion events
/camera video <id> — Get video
/camera photo <id> — Get photo
/mute <sensor> — Mute sensor
/unmute <sensor> — Unmute sensor
/quiet_hours HH:MM-HH:MM — Set quiet hours
/ping — Check bot response
/help — This message
```

### Output — Admin
All user commands plus:
```
🔧 Admin Commands

/config add|modify|remove — Sensor config
/export_config — Export config YAML
/import_config — Import config YAML
/invite — Generate invite code
/promote <user> — Promote to admin
/demote <user> — Demote to user
/health — System health
/update — Update worker
/rollback — Revert update
/system_update — Update system deps
/feature enable|disable — Toggle features
/gdrive status — Drive sync status
/camera enable|disable — Motion daemon
/restart — Restart worker
```

### Edge Cases
- Unregistered user → bot does not respond (handled in bot core)
