# 13 — /update, /rollback, /restart Commands

## Dependencies
- 06-bot-core.md (bot instance, role guard)
- 01-database.md (system_meta table)
- 24-ota.md (update.sh script)

---

## /update

### Access
Admin only

### Syntax
```
/update
```

### Behavior
1. Authorize the exact OTA operation through the Telegram application service.
2. Reply with the operation receipt and status from the signed OTA workflow.
3. Never execute `scripts/update.sh`; that compatibility entry point exits 64 and directs operators back to `/update`.
4. Never use repository, checkout-copy, or unsigned release fallbacks.

### Output
```
🔄 Checking for updates...
```
Then either:
```
✅ Updated successfully.
Commit: abc1234
Changes: 3 files changed
```
Or:
```
ℹ️ Already up to date.
```

### Error Cases
| Condition | Response |
|-----------|----------|
| Update already running | "⏳ Update already in progress, please wait." |
| Signed metadata or artifact validation fails | Report the typed OTA failure receipt |
| Preparation or activation fails | Preserve the current release and report the typed failure receipt |
| Health check fails | Authenticated activation performs its bounded rollback workflow |

### Concurrent Prevention
Lockfile `/tmp/home-worker-updating.lock` created at start, removed on exit (via `trap`). Bot checks lockfile before triggering.

---

## /rollback

### Access
Admin only

### Syntax
```
/rollback
```

### Behavior
1. Find most recent `rollback-*` git tag
2. `git reset --hard <tag>`
3. `corepack yarn install --immutable`
4. `pm2 restart worker`
5. Notify result

### Output
```
⏪ Rolling back to previous version...
✅ Rolled back to commit abc1234.
```

### Error Cases
| Condition | Response |
|-----------|----------|
| No rollback tags found | "❌ No previous version to roll back to." |
| Rollback fails | "❌ Rollback failed: [error]. SSH access may be needed." |

---

## /restart

### Access
Admin only

### Syntax
```
/restart
```

### Behavior
1. Store `restart_reason: 'user_command'` in `system_meta`
2. Reply: "🔄 Restarting..." (await delivery before proceeding)
3. Trigger `pm2 restart worker`
4. On boot, worker checks `system_meta` for restart reason
5. If `user_command`: send "✅ Restart complete." and clear the flag
6. If no flag (crash restart): send normal "system online" notification

### Output
```
🔄 Restarting...
```
After restart:
```
✅ Restart complete. Uptime reset.
```

### Key Detail
The reply "Restarting..." must be `await`ed before calling pm2 restart. Otherwise grammY may not flush the message before SIGINT arrives.
