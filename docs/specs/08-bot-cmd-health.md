# 08 — /health Command

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (system_meta, DB file)
- 02-sensor-core.md (sensor registry)

## Access
Admin only

## Syntax
```
/health
```

## Behavior

Gather system metrics and report:

| Metric | Source |
|--------|--------|
| Disk usage | `df` command on root partition |
| CPU temperature | `/sys/class/thermal/thermal_zone0/temp` |
| Memory | `process.memoryUsage()` + `os.totalmem()`/`os.freemem()` |
| Uptime | `process.uptime()` |
| DB size | `fs.statSync(DATABASE_PATH).size` |
| Bot polling | Time since last received update |
| Sensors online | Count from sensor registry |
| Motion storage | `du` on `MOTION_LOCAL_DIR` + rclone `about` for Drive |

## Output Format

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

## Edge Cases
- Motion feature disabled → omit Motion line
- Google Drive not configured → omit Drive part of Motion line
- CPU temp file not found (some Pi models) → show "N/A"
- rclone `about` fails → show "Drive: unavailable"

## Error Cases
- Any metric fails to collect → show that line as "N/A", don't fail entire command

## Contextual workflow return

`/health` begins a receipt-bound `health` workflow with System as its natural
parent. Every workflow-local action is tied to the current 16-character receipt
ID. `wr:<id>:o` restores the current authorized System view; `wr:<id>:h` opens
Home. A return from cancellable setup clears only that receipt's draft; a
running check is allowed to finish and its terminal result is sent before a
fresh menu is restored. No migration is required.
