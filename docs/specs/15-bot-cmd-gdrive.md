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

## Return Home behavior

Drive uses the shared `rh:d:<c|t>` workflow code from
[06-bot-core.md](06-bot-core.md#authoritative-home-callback-pipeline).

| Workflow state | Return Home behavior |
|---|---|
| Drive status or error | `rh:d:t` (`alreadyTerminal`); open a new Home directly. |
| Drive-auth prompt or retry while `awaitingConfig` | `rh:d:c` (`cancelPending`); delete only the pending auth input state, then open a new Home. |
| Drive-auth success, typed terminal failure, or demotion | `rh:d:t` (`alreadyTerminal`); open a new Home directly. |

Drive-auth continuation messages resolve the current role before accepting
input; demotion clears the pending auth state. Return Home does not expose or
carry the submitted Drive configuration.
