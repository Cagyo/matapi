#!/bin/bash
# Apply OS-level dependency updates (spec 18 / spec 24).
# Triggered by the /system_update bot command after admin confirmation.
#
# Sequence: snapshot current state -> apt upgrade (curated set) ->
# rclone selfupdate -> print manual Node update instructions -> health check.
# On health-check failure, notify the admin via a direct curl to the
# Telegram API (the worker may be down) and exit non-zero.
set -euo pipefail

INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-/opt/home-worker}"
DEPS_FILE="${INSTALL_DIR}/config/system-deps.yml"
SNAPSHOT="${INSTALL_DIR}/data/system-snapshot.txt"

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
  sudo apt-get update
  sudo apt-get install -y --only-upgrade motion ffmpeg mosquitto
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
      -d "text=⚠️ System update failed health check. SSH in to investigate." \
      >/dev/null || true
  fi
}

main() {
  snapshot_current
  update_apt
  update_rclone
  update_node_minor

  if ! health_check; then
    echo "Health check failed"
    notify_failure
    exit 1
  fi

  echo "System update complete"
}

main
