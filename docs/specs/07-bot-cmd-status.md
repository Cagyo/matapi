# 07 — /status, /ping, /help Commands

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (sensors table)
- 02-sensor-core.md (sensor registry)

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
