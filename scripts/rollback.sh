#!/bin/bash
# OTA rollback — `git reset --hard` to the most recent `rollback-*` tag,
# reinstall, rebuild, and pm2-restart. The worker reads `restart_reason`
# on boot and reports the outcome to admins.
#
# Spec 13 (/rollback).
set -euo pipefail

INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-/opt/home-worker}"
LOCKFILE="${HOME_WORKER_UPDATE_LOCK:-/tmp/home-worker-updating.lock}"
APP_NAME="${PM2_APP_NAME:-worker}"
DB_PATH="${DATABASE_PATH:-$INSTALL_DIR/data/dev.db}"

if [[ -e "$LOCKFILE" ]]; then
  echo "Update already in progress (lockfile $LOCKFILE exists)" >&2
  exit 2
fi
echo "$$" > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

cd "$INSTALL_DIR"

write_meta() {
  local key="$1"
  local value="$2"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" "INSERT INTO system_meta(key, value) VALUES('$key', '$value') ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
  else
    KEY="$key" VAL="$value" DBP="$DB_PATH" INST="$INSTALL_DIR" node -e "const Database=require(process.env.INST+'/node_modules/better-sqlite3');const db=new Database(process.env.DBP);db.prepare('INSERT INTO system_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(process.env.KEY,process.env.VAL);db.close();"
  fi
}

# Pick the newest `rollback-*` tag (lexical sort works because they are
# `rollback-<unix_epoch>`).
TARGET_TAG="$(git tag -l 'rollback-*' | sort | tail -n 1)"
if [[ -z "$TARGET_TAG" ]]; then
  echo "No rollback tag found" >&2
  write_meta "restart_reason" "rollback_failed"
  write_meta "rollback_status" "no_tag"
  exit 1
fi

if ! git reset --hard "$TARGET_TAG"; then
  write_meta "restart_reason" "rollback_failed"
  exit 1
fi
TARGET_COMMIT="$(git rev-parse HEAD)"

corepack yarn install --immutable
corepack yarn build

write_meta "restart_reason" "rollback"
write_meta "rollback_commit" "$TARGET_COMMIT"
pm2 restart "$APP_NAME"

echo "Rollback complete: $TARGET_COMMIT"