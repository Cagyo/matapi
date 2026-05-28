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
1. Check for update lockfile (`/tmp/home-worker-updating.lock`) — if exists, reject
2. Reply: "🔄 Checking for updates..."
3. Trigger `scripts/update.sh` as child process
4. Script: git fetch → compare → tag rollback point → git reset → yarn install --immutable → drizzle migrate → pm2 restart → 30s health check
5. If health check passes: bot sends "✅ Update complete. Version: <commit_hash>"
6. If health check fails: script rolls back automatically, notifies via direct curl to Telegram API

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
| Git fetch fails | "❌ Failed to check for updates: [error]" |
| yarn install fails | Auto-rollback, notify: "❌ Update failed, rolled back." |
| Health check fails (app crashes within 30s) | Auto-rollback, notify via curl |

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
