#!/bin/bash
# Apply OS-level dependency updates (spec 18 / spec 24).
# Triggered by the /system_update bot command after admin confirmation.
#
# Sequence: snapshot current state -> apt upgrade (curated set) ->
# rclone selfupdate -> node minor bump (same major only) -> health check.
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
  if [ -z "$DESIRED_MAJOR" ]; then
    echo "No desired node major in system-deps.yml; skipping node update."
    return
  fi
  CURRENT_MAJOR=$(node -v | cut -d'.' -f1 | tr -d 'v')

  if [ "$CURRENT_MAJOR" != "$DESIRED_MAJOR" ]; then
    echo "Node major version mismatch ($CURRENT_MAJOR vs $DESIRED_MAJOR). Skipping."
    return
  fi

  # Only minor/patch update within the same major.
  curl -fsSL "https://deb.nodesource.com/setup_${DESIRED_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
  cd "$INSTALL_DIR" && corepack yarn install --immutable
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
