# 18 — /system_update Command

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 00-overview.md (system-deps.yml)
- 24-ota.md (system-update.sh script)

## Access
Admin only

## Syntax
```
/system_update
```

## Behavior

1. Read `config/system-deps.yml` for expected versions
2. Compare with currently installed versions
3. Show diff to admin
4. Wait for confirmation via inline keyboard

### Step 1 — Show diff
```
🔄 System update available:

• motion: 4.5.1 → 4.6.0
• rclone: 1.65 → 1.67
• ffmpeg: no update
• node: 20.11 → 20.14 (minor)

[Apply] [Cancel]
```

### Step 2 — On Apply
1. Trigger `scripts/system-update.sh` as background process
2. Script: snapshot current → apt update → install packages → rclone selfupdate → node minor update → health check
3. Health check: start app, verify it stays up for 30 seconds
4. On success: "✅ System update complete."
5. On failure: notify via direct curl to Telegram API (worker may be dead): "⚠️ System update failed. SSH in to investigate."

### Step 3 — On Cancel
"System update cancelled."

## Node.js Major Version Policy
- Only minor/patch versions auto-upgraded (20.11 → 20.14)
- Major version changes (20 → 22) are **never automatic**
- Major upgrades require manual `.yml` change + awareness of native module recompilation

## system-deps.yml
```yaml
node: "20"          # major only
motion: "latest"
rclone: "latest"
ffmpeg: "latest"
mosquitto: "latest"
```

## Error Cases
| Condition | Response |
|-----------|----------|
| All up to date | "✅ All system dependencies are up to date." |
| apt update fails | "❌ Failed to check for updates: [error]" |
| Update script fails | Direct curl notification to admin |
| Node major version mismatch | "⚠️ Node.js major version change detected (20→22). This requires manual intervention." |

## Contextual workflow return

System update uses a receipt-bound `system-update` workflow with System as its
natural parent. Its exact callbacks are `wr:<id>:o` and `wr:<id>:h`; the
callback never encodes phase or authorization. A pending confirmation is
discarded only when its receipt matches. Once the update is spawned, the
receipt is `running`: return opens the requested menu but never stops or waits
for the detached script. After its health check, the script persists either
`system_update` or `system_update_failed` in `system_meta.restart_reason` and
performs a final worker restart. Startup completes the matching receipt with a
localized terminal outcome, then restores a fresh authorized menu unless the
user already returned. Any earlier script error follows the same failure
recovery path, with the direct Telegram API notification retained as fallback.
