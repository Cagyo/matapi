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

# Create pre-update rollback snapshot
mkdir -p /opt/home-worker/data/rollbacks
ROLLBACK_SNAPSHOT="/opt/home-worker/data/rollbacks/rollback-$(date +%s).tar.gz"
tar -czf "$ROLLBACK_SNAPSHOT" --exclude="data" --exclude="node_modules" --exclude=".git" -C /opt/home-worker .

# Prune old snapshots (retain only 3 newest)
ls -t /opt/home-worker/data/rollbacks/rollback-*.tar.gz 2>/dev/null | tail -n +4 | xargs -I {} rm -f "{}" || true

# Download release tarball from GitHub Releases (or fallback to git fetch)
RELEASE_URL="${HOME_WORKER_RELEASE_URL:-}"
if [ -n "$RELEASE_URL" ] && curl --output /dev/null --silent --head --fail "$RELEASE_URL" 2>/dev/null; then
  TMP_TAR="/tmp/home-worker-release.tar.gz"
  STAGING="/tmp/staging-$$"
  curl -fsSL "$RELEASE_URL" -o "$TMP_TAR"
  mkdir -p "$STAGING"
  tar -xzf "$TMP_TAR" -C "$STAGING"
  rsync -av --delete --exclude="data" --exclude="node_modules" --exclude=".git" "$STAGING/" /opt/home-worker/
  rm -rf "$STAGING" "$TMP_TAR"
else
  git fetch origin main
  git reset --hard origin/main
fi

# Install production deps without building (jobs=1 sequential native rebuilds)
export NODE_OPTIONS="--max-old-space-size=512"
export npm_config_jobs=1
export JOBS=1
corepack yarn workspaces focus -A --production

# Run DB migrations
corepack yarn db:migrate

# Restart and verify health
pm2 restart worker

sleep 30
if ! pm2 show worker | grep -q "online"; then
  echo "Health check failed, rolling back"
  tar -xzf "$ROLLBACK_SNAPSHOT" -C /opt/home-worker
  corepack yarn workspaces focus -A --production
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
PREV=$(ls -t /opt/home-worker/data/rollbacks/rollback-*.tar.gz 2>/dev/null | head -1 || true)

if [ -z "$PREV" ]; then
  echo "No rollback snapshot found"
  exit 1
fi

tar -xzf "$PREV" -C /opt/home-worker
export NODE_OPTIONS="--max-old-space-size=512"
export npm_config_jobs=1
export JOBS=1
corepack yarn workspaces focus -A --production
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
}

update_apt() {
  sudo apt-get update
  sudo apt-get install -y --only-upgrade motion ffmpeg mosquitto
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

## Restart Step

`update.sh` restarts through `restart_worker()`, which runs `pm2 startOrRestart
"$INSTALL_DIR/ecosystem.config.js" --update-env --only "$APP_NAME"` under a scrubbed environment, and
`pm2 save` once the health check has passed. Restarting from the config file rather than by name is what lets
an update change the PM2 restart policy at all; the environment scrub keeps update.sh's own variables
(`DATABASE_PATH`, `HOME_WORKER_*`) out of the app's persisted `pm2_env`, where they would shadow `.env`. See
[23-reliability.md](23-reliability.md) → *How these values reach a running device*, including the one-release
lag that applies to any change to `update.sh` itself.

## Health Check Details

After the restart, the script waits `UPDATE_HEALTH_CHECK_SEC` (30 s) and then requires two things of the
worker: PM2 status `online`, **and** a PM2 `restart_time` that has advanced by no more than one from the
reading taken immediately *before* the restart — that one increment being the update's own restart. The second
condition exists because a crash-looping build reads `online` for most of each `restart_delay` cycle; only the
restart counter distinguishes "up" from "up again". Together they catch:
- Syntax errors in new code
- Missing dependencies
- Incompatible native modules after Node update
- Failed DB migrations that crash on startup
- A build that starts, crashes, and is restarted by PM2 inside the check window

If either check fails — or if the restart command itself fails — rollback is automatic.

## Node.js Major Version Policy

- `system-deps.yml` specifies Node 22 as the supported major
- Bot-triggered updates never change Node; minor, patch, and major updates are manual
- Any Node upgrade requires:
  1. Manual edit of `system-deps.yml`
  2. Awareness that all native modules (`better-sqlite3`, `pigpio`) recompile
  3. `install_production_deps` after Node upgrade rebuilds native addons sequentially with `jobs=1`
  4. If rebuild fails, health check catches it

## Migration Safety

- Migrations run before PM2 restart in `update.sh`
- Migrations must be backward-compatible: old code should work with new schema
- This matters because rollback restores old code but does NOT rollback the DB migration
- When writing migrations: only add columns (with defaults), don't remove or rename
