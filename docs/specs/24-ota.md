# 24 — OTA Updates

## Dependencies
- 00-overview.md (system-deps.yml)
- 06-bot-core.md (bot for notifications)
- 01-database.md (migrations)

## App Update Script

```bash
#!/bin/bash
# scripts/update.sh
set -euo pipefail

LOCKFILE="/tmp/home-worker-updating.lock"
if [ -f "$LOCKFILE" ]; then
  echo "Update already in progress"
  exit 1
fi
touch "$LOCKFILE"
trap "rm -f $LOCKFILE" EXIT

cd /opt/home-worker
PREV_COMMIT=$(git rev-parse HEAD)
git fetch origin main

REMOTE=$(git rev-parse origin/main)
if [ "$PREV_COMMIT" = "$REMOTE" ]; then
  echo "Already up to date"
  exit 0
fi

git tag "rollback-$(date +%s)" "$PREV_COMMIT"
git reset --hard origin/main
corepack yarn install --immutable

# Run DB migrations
corepack yarn db:migrate

# Restart and verify health
pm2 restart worker

sleep 30
if ! pm2 show worker | grep -q "online"; then
  echo "Health check failed, rolling back"
  git reset --hard "$PREV_COMMIT"
  corepack yarn install --immutable
  pm2 restart worker
  curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${ADMIN_TELEGRAM_ID}" \
    -d "text=⚠️ Update failed health check. Rolled back to previous version."
  exit 1
fi

echo "Update successful"
```

## Rollback Script

```bash
#!/bin/bash
# scripts/rollback.sh
set -euo pipefail

cd /opt/home-worker
PREV=$(git tag --list 'rollback-*' --sort=-creatordate | head -1)

if [ -z "$PREV" ]; then
  echo "No rollback tag found"
  exit 1
fi

git reset --hard "$PREV"
corepack yarn install --immutable
pm2 restart worker
echo "Rolled back to $PREV"
```

## System Update Script

```bash
#!/bin/bash
# scripts/system-update.sh
set -euo pipefail

SNAPSHOT="/opt/home-worker/data/system-snapshot.txt"

# Snapshot current state
snapshot_current() {
  dpkg -l | grep -E "motion|ffmpeg|mosquitto" > "$SNAPSHOT"
  node -v >> "$SNAPSHOT"
  rclone version >> "$SNAPSHOT" 2>/dev/null || echo "rclone: not installed" >> "$SNAPSHOT"
}

update_apt() {
  sudo apt-get update
  sudo apt-get install -y --only-upgrade motion ffmpeg mosquitto
}

update_rclone() {
  if command -v rclone &>/dev/null; then
    sudo rclone selfupdate
  fi
}

update_node_minor() {
  DESIRED_MAJOR=$(grep 'node:' /opt/home-worker/config/system-deps.yml | awk '{print $2}' | tr -d '"')
  CURRENT_MAJOR=$(node -v | cut -d'.' -f1 | tr -d 'v')

  if [ "$CURRENT_MAJOR" != "$DESIRED_MAJOR" ]; then
    echo "Node major version mismatch ($CURRENT_MAJOR vs $DESIRED_MAJOR). Skipping."
    return
  fi

  # Only minor/patch update within same major
  curl -fsSL https://deb.nodesource.com/setup_${DESIRED_MAJOR}.x | sudo -E bash -
  sudo apt-get install -y nodejs
  cd /opt/home-worker && corepack yarn install --immutable
}

health_check() {
  pm2 restart worker
  sleep 30
  pm2 show worker | grep -q "online"
}

main() {
  snapshot_current
  update_apt
  update_rclone
  update_node_minor

  if ! health_check; then
    echo "Health check failed"
    curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${ADMIN_TELEGRAM_ID}" \
      -d "text=⚠️ System update failed health check. SSH in to investigate."
    exit 1
  fi

  echo "System update complete"
}

main
```

## Trigger Methods

- `/update` bot command (admin only) — most common
- `/system_update` bot command (admin only, with confirmation UI)
- Optional hourly cron (for app updates only):

```bash
# /etc/cron.d/home-worker-update
0 * * * * homeworker /opt/home-worker/scripts/update.sh >> /var/log/home-worker-update.log 2>&1
```

## Health Check Details

After pm2 restart, the script waits 30 seconds and checks if the process is still online. This catches:
- Syntax errors in new code
- Missing dependencies
- Incompatible native modules after Node update
- Failed DB migrations that crash on startup

If the check fails, rollback is automatic.

## Node.js Major Version Policy

- `system-deps.yml` specifies major version only (e.g., `node: "20"`)
- Minor/patch updates within the major are safe and automatic
- Major upgrades (20→22) require:
  1. Manual edit of `system-deps.yml`
  2. Awareness that all native modules (`better-sqlite3`, `pigpio`) recompile
  3. `yarn install` after Node upgrade rebuilds native addons
  4. If rebuild fails, health check catches it

## Migration Safety

- Migrations run before PM2 restart in `update.sh`
- Migrations must be backward-compatible: old code should work with new schema
- This matters because rollback restores old code but does NOT rollback the DB migration
- When writing migrations: only add columns (with defaults), don't remove or rename
