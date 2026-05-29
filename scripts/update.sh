#!/bin/bash
# OTA update — fetches origin/main, tags a rollback point, installs, builds,
# migrates, pm2-restarts, then runs a post-restart health check. On failure
# resets to the rollback tag, reinstalls, restarts again, and lets the
# worker surface the outcome via the `update_status` flag in system_meta
# on next boot.
#
# Spec 13 (/update) + spec 24 (OTA).
set -euo pipefail

INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-/opt/home-worker}"
LOCKFILE="${HOME_WORKER_UPDATE_LOCK:-/tmp/home-worker-updating.lock}"
APP_NAME="${PM2_APP_NAME:-worker}"
HEALTH_CHECK_SEC="${UPDATE_HEALTH_CHECK_SEC:-30}"
DB_PATH="${DATABASE_PATH:-$INSTALL_DIR/data/dev.db}"

if [[ -e "$LOCKFILE" ]]; then
  echo "Update already in progress (lockfile $LOCKFILE exists)" >&2
  exit 2
fi
echo "$$" > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

cd "$INSTALL_DIR"

# Write key/value into system_meta. Uses sqlite3 if available, otherwise
# falls back to better-sqlite3 via a tiny node one-liner.
write_meta() {
  local key="$1"
  local value="$2"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" "INSERT INTO system_meta(key, value) VALUES('$key', '$value') ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
  else
    KEY="$key" VAL="$value" DBP="$DB_PATH" INST="$INSTALL_DIR" node -e "const Database=require(process.env.INST+'/node_modules/better-sqlite3');const db=new Database(process.env.DBP);db.prepare('INSERT INTO system_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(process.env.KEY,process.env.VAL);db.close();"
  fi
}

rollback_to_tag() {
  local tag="$1"
  git reset --hard "$tag" || true
  corepack yarn install --immutable || true
  corepack yarn build || true
  write_meta "restart_reason" "ota_update_failed"
  write_meta "update_status" "failed"
  pm2 restart "$APP_NAME" || true
}

CURRENT_COMMIT="$(git rev-parse HEAD)"
git fetch origin
REMOTE_COMMIT="$(git rev-parse origin/main)"

if [[ "$CURRENT_COMMIT" == "$REMOTE_COMMIT" ]]; then
  echo "Already up to date"
  exit 0
fi

ROLLBACK_TAG="rollback-$(date +%s)"
git tag "$ROLLBACK_TAG" "$CURRENT_COMMIT"
git reset --hard origin/main
NEW_COMMIT="$(git rev-parse HEAD)"

write_meta "restart_reason" "ota_update"
write_meta "update_commit" "$NEW_COMMIT"
write_meta "update_rollback_tag" "$ROLLBACK_TAG"

if ! corepack yarn install --immutable; then
  echo "yarn install failed, rolling back" >&2
  rollback_to_tag "$ROLLBACK_TAG"
  exit 1
fi
if ! corepack yarn build; then
  echo "yarn build failed, rolling back" >&2
  rollback_to_tag "$ROLLBACK_TAG"
  exit 1
fi
if ! corepack yarn db:migrate; then
  echo "migrations failed, rolling back" >&2
  rollback_to_tag "$ROLLBACK_TAG"
  exit 1
fi

write_meta "update_status" "pending"
pm2 restart "$APP_NAME"

# Post-restart health check. pm2 restart returns immediately; give the
# worker HEALTH_CHECK_SEC seconds to come back online.
sleep "$HEALTH_CHECK_SEC"
STATUS="$(APP_NAME="$APP_NAME" pm2 jlist 2>/dev/null | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{const apps=JSON.parse(s);const app=apps.find(a=>a.name===process.env.APP_NAME);process.stdout.write(app?app.pm2_env.status:'missing');}catch(_){process.stdout.write('unknown');}});" || echo unknown)"

if [[ "$STATUS" != "online" ]]; then
  echo "Health check failed (pm2 status=$STATUS), rolling back" >&2
  rollback_to_tag "$ROLLBACK_TAG"
  exit 1
fi

write_meta "update_status" "success"
echo "Update complete: $NEW_COMMIT"
