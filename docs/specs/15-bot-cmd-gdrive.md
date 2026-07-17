# 15 — /gdrive status Command

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 21-gdrive.md (rclone service)

## Access
Admin only

## Syntax
```
/gdrive status
```

## Behavior
1. Run `rclone about gdrive:` to get quota info
2. Query `motion_events` for upload stats
3. Report sync health

## Output
```
☁️ Google Drive Status

📦 Used: 8.2 GB / 15.0 GB (55%)
📤 Last upload: 08.04.2026 15:30
📋 Pending uploads: 3 files
⚠️ Failed uploads: 0
🗑️ Auto-cleanup: active (min age: 30 days)
```

If sync is failing:
```
☁️ Google Drive Status

📦 Used: 12.1 GB / 15.0 GB (81%)
📤 Last upload: 05.04.2026 09:12
📋 Pending uploads: 47 files
⚠️ Failed uploads: 5 (last error: auth token expired)
🗑️ Auto-cleanup: active (min age: 30 days)
🚨 Sync unhealthy — 5 consecutive failures
```

## Error Cases
| Condition | Response |
|-----------|----------|
| rclone not installed | "❌ rclone is not installed" |
| rclone not configured | "❌ Google Drive not configured. Run rclone config." |
| rclone about fails | "❌ Failed to check Drive status: [error]" |

## Contextual workflow return

Drive status and setup use receipt-bound `drive-status` and `drive-setup`
workflows, both with Storage & backup as the natural parent. `wr:<id>:o`
restores that authorized parent; `wr:<id>:h` opens Home. The callback contains
only the receipt ID and destination, never submitted Drive configuration.
Drive-auth input is cancelled only when its receipt matches. Demotion or a
deleted dynamic origin re-authorizes through the parent fallback, and restart
loss of in-memory auth input yields localized interruption copy rather than a
mutation of newer work.
