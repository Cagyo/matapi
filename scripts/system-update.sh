#!/bin/bash
# Apply OS-level dependency updates (spec 18 / spec 24).
# Triggered by the /system_update bot command after admin confirmation.
#
# Sequence: snapshot current state -> apt upgrade (curated set) ->
# rclone selfupdate -> print manual Node update instructions -> health check.
# Any failure records a terminal outcome, restarts the worker for receipt
# recovery, then uses direct curl as a notification fallback.
set -Eeuo pipefail

INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-/opt/home-worker}"
DEPS_FILE="${INSTALL_DIR}/config/system-deps.yml"
SNAPSHOT="${INSTALL_DIR}/data/system-snapshot.txt"
APT_LOCK_TIMEOUT_SECONDS=300

configured_database_path() {
  if [[ -n "${DATABASE_PATH:-}" ]]; then
    printf '%s\n' "$DATABASE_PATH"
    return
  fi

  local configured_path
  configured_path="$(
    sed -n -E 's/^[[:space:]]*DATABASE_PATH[[:space:]]*=[[:space:]]*//p' "$INSTALL_DIR/.env" 2>/dev/null |
      tail -n 1 |
      sed -E 's/[[:space:]]*$//' || true
  )"

  printf '%s\n' "${configured_path:-$INSTALL_DIR/data/worker.db}"
}

DB_PATH="$(configured_database_path)"

# Record the terminal outcome before the final restart so the new process can
# complete the exact running system-update receipt after its health check.
write_meta() {
  local key="$1"
  local value="$2"
  if command -v sqlite3 >/dev/null 2>&1; then
    local esc_key=${key//"'"/"''"}
    local esc_value=${value//"'"/"''"}
    sqlite3 "$DB_PATH" "INSERT INTO system_meta(key, value) VALUES('$esc_key', '$esc_value') ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
  else
    KEY="$key" VAL="$value" DBP="$DB_PATH" INST="$INSTALL_DIR" node -e "const Database=require(process.env.INST+'/node_modules/better-sqlite3');const db=new Database(process.env.DBP);db.prepare('INSERT INTO system_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(process.env.KEY,process.env.VAL);db.close();"
  fi
}

apt_get() {
  sudo apt-get -o "DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}" "$@"
}

snapshot_current() {
  {
    dpkg -l | grep -E "motion|ffmpeg|mosquitto" || true
    node -v
    rclone version 2>/dev/null || echo "rclone: not installed"
  } > "$SNAPSHOT"
}

update_apt() {
  # NOTE: every sudo command below must exactly match an entry in
  # /etc/sudoers.d/homeworker-sysupdate (written by install.sh) — args included.
  apt_get update
  apt_get install -y --only-upgrade motion ffmpeg mosquitto
}

update_rclone() {
  if command -v rclone &>/dev/null; then
    sudo rclone selfupdate
  fi
}

update_node_minor() {
  DESIRED_MAJOR=$(grep '^node:' "$DEPS_FILE" | awk '{print $2}' | tr -d '"')
  CURRENT_MAJOR=$(node -v | cut -d'.' -f1 | tr -d 'v')

  if [ -n "$DESIRED_MAJOR" ] && [ "$CURRENT_MAJOR" != "$DESIRED_MAJOR" ]; then
    echo "Node major version mismatch ($CURRENT_MAJOR installed vs $DESIRED_MAJOR desired)."
  fi

  # Node upgrades pipe a remote script into root bash — too much power for a
  # bot-triggered path and impossible to whitelist in sudoers. Manual only:
  echo "Node updates are not performed by /system_update. To update, SSH in and run:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_<major>.x | sudo -E bash - && sudo apt-get install -y nodejs"
}

health_check() {
  pm2 restart worker
  sleep 30
  pm2 show worker | grep -q "online"
}

notify_failure() {
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${ADMIN_TELEGRAM_ID:-}" ]; then
    curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${ADMIN_TELEGRAM_ID}" \
      -d "text=⚠️ System update failed. SSH in to investigate." \
      >/dev/null || true
  fi
}

report_failure() {
  local exit_code="${1:-1}"
  trap - ERR
  echo "System update failed"
  if write_meta "restart_reason" "system_update_failed" && pm2 restart worker; then
    exit "$exit_code"
  fi
  notify_failure
  exit "$exit_code"
}

trap 'report_failure $?' ERR

main() {
  snapshot_current
  update_apt
  update_rclone
  update_node_minor

  if ! health_check; then
    echo "Health check failed"
    report_failure 1
  fi

  write_meta "restart_reason" "system_update"
  pm2 restart worker
  echo "System update complete"
}

main
