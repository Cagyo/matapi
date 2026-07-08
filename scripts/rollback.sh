#!/bin/bash
# OTA rollback — restores from the most recent snapshot tarball in data/rollbacks/
# (with fallback to git reset --hard for rollback-* tags), reinstalls production deps
# without building, and pm2-restarts. The worker reads `restart_reason`
# on boot and reports the outcome to admins.
#
# Spec 13 (/rollback).
set -euo pipefail

INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-/opt/home-worker}"
LOCKFILE="${HOME_WORKER_UPDATE_LOCK:-/tmp/home-worker-updating.lock}"
APP_NAME="${PM2_APP_NAME:-worker}"
DB_PATH="${DATABASE_PATH:-$INSTALL_DIR/data/worker.db}"

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

install_production_deps() {
  echo "Configuring low-memory Yarn settings in $INSTALL_DIR/.yarnrc.yml..."
  cat <<'YAML' | tee "$INSTALL_DIR/.yarnrc.yml" >/dev/null
networkConcurrency: 4
compressionLevel: 0
enableGlobalCache: true
enableProgressBars: false
nodeLinker: node-modules
nmMode: hardlinks-global
YAML

  echo "Installing production dependencies with single-threaded job limits (jobs=1)..."
  export NODE_OPTIONS="--max-old-space-size=512"
  export npm_config_jobs=1
  export JOBS=1
  env NODE_OPTIONS="$NODE_OPTIONS" npm_config_jobs=1 JOBS=1 corepack yarn workspaces focus -A --production
}

# Pick the newest rollback snapshot tarball
NEWEST_SNAPSHOT="$(ls -t "$INSTALL_DIR/data/rollbacks"/rollback-*.tar.gz 2>/dev/null | head -1 || true)"
TARGET_COMMIT="snapshot"

if [[ -n "$NEWEST_SNAPSHOT" && -f "$NEWEST_SNAPSHOT" ]]; then
  echo "Restoring from rollback snapshot: $NEWEST_SNAPSHOT..."
  tar -xzf "$NEWEST_SNAPSHOT" -C "$INSTALL_DIR"
elif [[ -d "$INSTALL_DIR/.git" ]]; then
  TARGET_TAG="$(git tag -l 'rollback-*' | sort | tail -n 1 || true)"
  if [[ -z "$TARGET_TAG" ]]; then
    echo "No rollback snapshot or git rollback tag found" >&2
    write_meta "restart_reason" "rollback_failed"
    write_meta "rollback_status" "no_snapshot"
    exit 1
  fi
  echo "Restoring from git tag: $TARGET_TAG..."
  if ! git reset --hard "$TARGET_TAG"; then
    write_meta "restart_reason" "rollback_failed"
    exit 1
  fi
  TARGET_COMMIT="$(git rev-parse HEAD)"
else
  echo "No rollback snapshot found and $INSTALL_DIR is not a git repository" >&2
  write_meta "restart_reason" "rollback_failed"
  write_meta "rollback_status" "no_snapshot"
  exit 1
fi

install_production_deps

write_meta "restart_reason" "rollback"
write_meta "rollback_commit" "$TARGET_COMMIT"
pm2 restart "$APP_NAME"

echo "Rollback complete: $TARGET_COMMIT"
