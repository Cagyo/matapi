#!/bin/bash
set -euo pipefail

REPO="${HOME_WORKER_REPO:-https://github.com/CHANGE_ME/home-worker.git}"
INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-/opt/home-worker}"
NODE_VERSION="${HOME_WORKER_NODE_VERSION:-22}"
USER="${HOME_WORKER_USER:-homeworker}"
APT_LOCK_TIMEOUT_SECONDS=300
RTSP_GROUP_REFRESH_REQUIRED=0

export DEBIAN_FRONTEND=noninteractive
export APT_LISTCHANGES_FRONTEND=none
export NEEDRESTART_MODE=a

apt_get() {
  sudo apt-get -o "DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}" "$@"
}

main() {
  check_raspberry_pi
  setup_hardware_resources
  create_user
  install_system_deps
  provision_archive_installation_state
  install_node
  install_app
  setup_pigpiod
  setup_tmpfs
  prompt_config
  install_feature_management_artifacts
  configure_serial_headless
  patch_legacy_feature_serial_calls
  install_selected_features
  ensure_motion_video_storage_permissions
  setup_system_update_sudoers
  run_migrations
  seed_motion_camera_metadata
  setup_pm2
  print_done
  reboot_system
}

check_raspberry_pi() {
  if ! grep -q "Raspberry Pi" /proc/cpuinfo 2>/dev/null; then
    echo "WARNING: Not running on Raspberry Pi. Continuing anyway (dev mode)."
  fi
}

setup_hardware_resources() {
  echo "Checking hardware resources and filesystem..."

  # 1. Non-interactive filesystem expansion
  if command -v raspi-config >/dev/null 2>&1 || [ -f /etc/rpi-issue ]; then
    if ! apt_get update -qq || ! apt_get install -y cloud-guest-utils; then
      echo "WARNING: Could not install optional cloud-guest-utils; skipping live filesystem expansion support." >&2
    fi

    local root_dev disk part
    root_dev=$(findmnt / -o source -n 2>/dev/null || true)
    if [ -n "$root_dev" ]; then
      disk=$(lsblk -no pkname "$root_dev" 2>/dev/null | head -1 || true)
      part=$(lsblk -no partn "$root_dev" 2>/dev/null | head -1 || true)
      if [ -n "$disk" ] && [ -n "$part" ]; then
        if sudo growpart "/dev/$disk" "$part" 2>/dev/null; then
          sudo resize2fs "$root_dev" 2>/dev/null || true
          echo "Root filesystem expanded live online."
        fi
      fi
    fi
    if command -v raspi-config >/dev/null 2>&1; then
      sudo raspi-config nonint do_expand_rootfs >/dev/null 2>&1 || true
    fi
  fi

  # 2. Ensure swap space is configured to at least 2048MB and tune kernel memory behavior
  echo "Tuning kernel memory behavior (vm.swappiness=10)..."
  sudo sysctl -w vm.swappiness=10 2>/dev/null || true
  if [ -f /etc/sysctl.conf ] && ! grep -q "vm.swappiness" /etc/sysctl.conf; then
    echo "vm.swappiness=10" | sudo tee -a /etc/sysctl.conf >/dev/null || true
  elif [ -f /etc/sysctl.conf ]; then
    sudo sed -i 's/^vm\.swappiness=.*/vm.swappiness=10/' /etc/sysctl.conf || true
  fi

  local total_mem total_swap
  total_mem=$(free -m | awk '/^Mem:/{print $2}' || echo 0)
  total_swap=$(free -m | awk '/^Swap:/{print $2}' || echo 0)
  if [ "$((total_mem + total_swap))" -lt 2048 ]; then
    echo "Low memory detected (${total_mem}MB RAM + ${total_swap}MB Swap). Configuring 2GB persistent swapfile..."
    if command -v dphys-swapfile >/dev/null 2>&1; then
      echo "Disabling conflicting dphys-swapfile service..."
      sudo dphys-swapfile swapoff 2>/dev/null || true
      sudo systemctl disable --now dphys-swapfile 2>/dev/null || true
    fi
    if [ ! -f /swapfile ]; then
      echo "Creating /swapfile (2GB)..."
      sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
      sudo chmod 600 /swapfile
      sudo mkswap /swapfile
    fi
    sudo swapon /swapfile 2>/dev/null || true
    if [ -f /etc/fstab ] && ! grep -q "/swapfile" /etc/fstab; then
      echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
      echo "Added /swapfile to /etc/fstab for reboot persistence."
    fi
  else
    echo "Sufficient memory/swap available (${total_mem}MB RAM + ${total_swap}MB Swap)."
  fi
}

create_user() {
  if ! id "$USER" &>/dev/null; then
    sudo useradd -r -m -s /bin/bash "$USER"
    echo "Created system user: $USER"
  fi
  if [ ! -d "/home/$USER" ]; then
    sudo mkdir -p "/home/$USER"
    sudo chown "$USER:$USER" "/home/$USER"
  fi
}

provision_archive_installation_state() {
  local ARCHIVE_STATE_DIR="/etc/home-worker"
  if [ "${HOME_WORKER_INSTALL_LIBRARY:-0}" = "1" ]; then
    ARCHIVE_STATE_DIR="${HOME_WORKER_ARCHIVE_STATE_DIR:?HOME_WORKER_ARCHIVE_STATE_DIR is required for installer tests}"
  fi
  local ARCHIVE_KEY_PATH="$ARCHIVE_STATE_DIR/archive.key"
  local INSTALLATION_ID_PATH="$ARCHIVE_STATE_DIR/installation-id"

  sudo install -d -m 0750 -o root -g "$USER" "$ARCHIVE_STATE_DIR"

  if [ ! -e "$ARCHIVE_KEY_PATH" ] && [ ! -L "$ARCHIVE_KEY_PATH" ]; then
    create_immutable_archive_state_file "$ARCHIVE_STATE_DIR" "$ARCHIVE_KEY_PATH" archive-key
  fi
  if [ ! -e "$INSTALLATION_ID_PATH" ] && [ ! -L "$INSTALLATION_ID_PATH" ]; then
    create_immutable_archive_state_file "$ARCHIVE_STATE_DIR" "$INSTALLATION_ID_PATH" installation-id
  fi

  validate_archive_installation_state "$ARCHIVE_KEY_PATH" archive-key || return 1
  validate_archive_installation_state "$INSTALLATION_ID_PATH" installation-id || return 1
}

create_immutable_archive_state_file() {
  local state_dir="$1" target="$2" kind="$3" root_temporary
  root_temporary="$(sudo mktemp "$state_dir/.state.XXXXXX")"
  if ! sudo python3 - "$root_temporary" "$kind" <<'PY'
import os
import sys
import uuid

path, kind = sys.argv[1:]
with open(path, 'wb') as stream:
    if kind == 'archive-key':
        stream.write(os.urandom(32))
    else:
        stream.write(f'{uuid.uuid4()}\n'.encode('ascii'))
    stream.flush()
    os.fsync(stream.fileno())
PY
  then
    sudo rm -f "$root_temporary"
    return 1
  fi
  if ! sudo chown root:"$USER" "$root_temporary" || ! sudo chmod 0640 "$root_temporary"; then
    sudo rm -f "$root_temporary"
    return 1
  fi

  # Linking the prepared root-owned file publishes it only when absent. A
  # concurrent or repeat installer keeps the original installation secret.
  if ! sudo ln "$root_temporary" "$target"; then
    sudo rm -f "$root_temporary"
    if sudo test -e "$target"; then
      return 0
    fi
    echo "ERROR: could not provision immutable archive installation state" >&2
    return 1
  fi
  sudo rm -f "$root_temporary"
}

validate_archive_installation_state() {
  local path="$1" kind="$2" expected_uid=0 expected_gid
  if [ "${HOME_WORKER_INSTALL_LIBRARY:-0}" = "1" ]; then
    expected_uid="$(id -u)"
    expected_gid="$(id -g)"
  else
    expected_gid="$(id -g "$USER")"
  fi
  sudo python3 - "$path" "$kind" "$expected_uid" "$expected_gid" <<'PY'
import os
import stat
import sys
import uuid

path, kind, uid_text, gid_text = sys.argv[1:]
try:
    expected_uid, expected_gid = int(uid_text), int(gid_text)
    metadata = os.lstat(path)
except (OSError, ValueError):
    raise SystemExit('invalid archive installation state')
if (not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_nlink != 1 or metadata.st_uid != expected_uid
        or metadata.st_gid != expected_gid or stat.S_IMODE(metadata.st_mode) != 0o640):
    raise SystemExit('invalid archive installation state')
with open(path, 'rb') as stream:
    value = stream.read(128)
    if stream.read(1):
        raise SystemExit('invalid archive installation state')
if kind == 'archive-key':
    valid = len(value) == 32
else:
    try:
        text = value.decode('ascii')
        parsed = uuid.UUID(text.rstrip('\n'))
        valid = text == f'{parsed}\n'
    except (UnicodeDecodeError, ValueError):
        valid = False
if not valid:
    raise SystemExit('invalid archive installation state')
PY
}

install_system_deps() {
  echo "Installing system dependencies..."
  apt_get update
  apt_get install -y \
    git sqlite3 libsqlite3-dev build-essential python3 python3-setuptools \
    ffmpeg \
    usb-modeswitch

  install_pigpio
}

install_pigpio() {
  if command -v pigpiod &>/dev/null; then
    echo "pigpiod already installed: $(command -v pigpiod)"
    return 0
  fi

  if apt-cache show pigpio &>/dev/null 2>&1; then
    echo "Installing pigpio from apt repository..."
    if apt_get install -y pigpio python3-pigpio; then
      return 0
    fi
  fi

  echo "Package pigpio not found in apt repository. Building pigpio from source..."
  local tmpdir
  tmpdir=$(mktemp -d)
  if git clone --depth 1 https://github.com/joan2937/pigpio.git "$tmpdir/pigpio" && \
     make -C "$tmpdir/pigpio" && \
     sudo make -C "$tmpdir/pigpio" install; then
    sudo ldconfig || true
    echo "pigpiod built and installed from source successfully."
  else
    echo "WARNING: Failed to install pigpio from source. Continuing installation without pigpiod."
  fi
  rm -rf "$tmpdir" || true
}

install_node() {
  if command -v node &>/dev/null; then
    CURRENT=$(node -v | cut -d'.' -f1 | tr -d 'v')
    if [ "$CURRENT" = "$NODE_VERSION" ]; then
      echo "Node.js $NODE_VERSION already installed: $(node -v)"
      return
    fi
  fi
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
  apt_get install -y nodejs
  echo "Node.js installed: $(node -v)"
  sudo corepack enable
}

install_production_deps() {
  echo "Configuring low-memory Yarn settings in $INSTALL_DIR/.yarnrc.yml..."
  cat <<'YAML' | sudo -u "$USER" tee "$INSTALL_DIR/.yarnrc.yml" >/dev/null
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
  sudo -u "$USER" env NODE_OPTIONS="$NODE_OPTIONS" npm_config_jobs=1 JOBS=1 corepack yarn workspaces focus -A --production
}

install_app() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local local_app_root
  local_app_root="$(cd "$script_dir/.." && pwd)"
  local local_source="${REPO#file://}"
  local needs_build=0

  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Updating existing git installation..."
    if command -v pm2 &>/dev/null; then
      echo "Stopping running PM2 worker instances before update..."
      sudo -u "$USER" pm2 stop ecosystem.config.js 2>/dev/null || true
    fi
    cd "$INSTALL_DIR"
    local before after branch
    before="$(sudo -u "$USER" git rev-parse HEAD 2>/dev/null || true)"
    branch="$(sudo -u "$USER" git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
    if [ -z "$branch" ]; then
      sudo -u "$USER" git remote set-head origin --auto >/dev/null 2>&1 || true
      branch="$(sudo -u "$USER" git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)"
    fi
    if [ -z "$branch" ]; then
      for candidate in master main; do
        if sudo -u "$USER" git rev-parse --verify "origin/$candidate" >/dev/null 2>&1; then
          branch="$candidate"
          break
        fi
      done
    fi
    if [ -z "$branch" ]; then
      echo "ERROR: cannot determine origin default branch" >&2
      exit 1
    fi
    sudo -u "$USER" git pull origin "$branch"
    after="$(sudo -u "$USER" git rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$before" ] && [ -n "$after" ] && [ "$before" != "$after" ]; then
      needs_build=1
    fi
  elif [ -f "$INSTALL_DIR/package.json" ]; then
    echo "Using existing manually deployed application files in $INSTALL_DIR (non-git installation)..."
    if command -v pm2 &>/dev/null; then
      echo "Stopping running PM2 worker instances before update..."
      sudo -u "$USER" pm2 stop ecosystem.config.js 2>/dev/null || true
    fi
    if [ -d "$local_source" ] && [ "$local_source" != "$INSTALL_DIR" ] && [ -f "$local_source/package.json" ]; then
      echo "Copying updated application files from $local_source to $INSTALL_DIR..."
      sudo cp -a "$local_source/." "$INSTALL_DIR/"
    elif [ -f "$local_app_root/package.json" ] && [ "$local_app_root" != "$INSTALL_DIR" ]; then
      echo "Copying updated application files from $local_app_root to $INSTALL_DIR..."
      sudo cp -a "$local_app_root/." "$INSTALL_DIR/"
    fi
    sudo chown -R "$USER:$USER" "$INSTALL_DIR"
  else
    if [ -d "$local_source" ]; then
      if [ -d "$local_source/.git" ]; then
        echo "Cloning local git repository from $local_source..."
        sudo git clone "$local_source" "$INSTALL_DIR"
      elif [ -f "$local_source/package.json" ]; then
        echo "Copying manually deployed application files from $local_source to $INSTALL_DIR..."
        sudo mkdir -p "$INSTALL_DIR"
        sudo cp -a "$local_source/." "$INSTALL_DIR/"
      else
        echo "ERROR: Local source directory '$local_source' does not contain package.json or a git repository."
        exit 1
      fi
    elif [ "$REPO" = "https://github.com/CHANGE_ME/home-worker.git" ] && [ -f "$local_app_root/package.json" ] && [ "$local_app_root" != "$INSTALL_DIR" ]; then
      echo "Copying local application files from $local_app_root to $INSTALL_DIR..."
      sudo mkdir -p "$INSTALL_DIR"
      sudo cp -a "$local_app_root/." "$INSTALL_DIR/"
    else
      echo "Cloning repository from $REPO..."
      sudo git clone "$REPO" "$INSTALL_DIR"
    fi
    sudo chown -R "$USER:$USER" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
  sudo chmod +x "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true
  if [ ! -f "$INSTALL_DIR/dist/main.js" ] || [ "$needs_build" = "1" ]; then
    echo "Building dist/ from source (slow on a Pi; swap was configured earlier)..."
    sudo -u "$USER" env NODE_OPTIONS="--max-old-space-size=512" npm_config_jobs=1 JOBS=1 corepack yarn install --immutable
    sudo -u "$USER" env NODE_OPTIONS="--max-old-space-size=512" npm_config_jobs=1 JOBS=1 corepack yarn build
    sudo -u "$USER" env NODE_OPTIONS="--max-old-space-size=512" npm_config_jobs=1 JOBS=1 corepack yarn workspaces focus -A --production
  else
    install_production_deps
  fi
}

setup_pigpiod() {
  if ! command -v pigpiod &>/dev/null; then
    echo "WARNING: pigpiod binary not found, skipping daemon setup"
    return 0
  fi

  if ! systemctl list-unit-files pigpiod.service &>/dev/null 2>&1; then
    if [ ! -f /lib/systemd/system/pigpiod.service ] && [ ! -f /etc/systemd/system/pigpiod.service ]; then
      local pigpiod_bin
      pigpiod_bin=$(command -v pigpiod)
      echo "Creating systemd service unit for pigpiod ($pigpiod_bin)..."
      cat <<EOF | sudo tee /etc/systemd/system/pigpiod.service >/dev/null
[Unit]
Description=Daemon required to control GPIO pins via pigpio
Documentation=man:pigpiod(8)

[Service]
ExecStart=${pigpiod_bin} -l
ExecStop=/bin/systemctl kill -s SIGKILL pigpiod
Type=forking

[Install]
WantedBy=multi-user.target
EOF
      sudo systemctl daemon-reload || true
    fi
  fi

  sudo systemctl enable pigpiod || true
  sudo systemctl start pigpiod || true
  echo "pigpiod enabled and started"
}

setup_tmpfs() {
  if ! grep -q "tmpfs /tmp" /etc/fstab; then
    echo "tmpfs /tmp tmpfs defaults,noatime,nosuid,size=100m 0 0" | sudo tee -a /etc/fstab
    echo "tmpfs /var/log tmpfs defaults,noatime,nosuid,size=50m 0 0" | sudo tee -a /etc/fstab
    echo "tmpfs entries added to /etc/fstab (effective after reboot)"
  fi
}

setup_system_update_sudoers() {
  # /system_update runs as $USER and shells these exact commands through sudo.
  # sudoers matches command paths AND arguments literally, so keep this list
  # in lockstep with scripts/system-update.sh (the lockstep check in the plan's
  # final verification greps both files). Both /usr/bin and /bin path variants
  # are listed (usr-merged vs older images). rclone's official installer puts
  # the binary in /usr/bin; if a future install lands in /usr/local/bin, add
  # that variant here too.
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
$USER ALL=(ALL) NOPASSWD: /usr/bin/apt-get -o DPkg::Lock::Timeout=300 update, /bin/apt-get -o DPkg::Lock::Timeout=300 update
$USER ALL=(ALL) NOPASSWD: /usr/bin/apt-get -o DPkg::Lock::Timeout=300 install -y --only-upgrade motion ffmpeg mosquitto, /bin/apt-get -o DPkg::Lock::Timeout=300 install -y --only-upgrade motion ffmpeg mosquitto
$USER ALL=(ALL) NOPASSWD: /usr/bin/rclone selfupdate, /bin/rclone selfupdate
EOF
  if sudo visudo -c -f "$tmp" >/dev/null; then
    sudo install -m 440 -o root -g root "$tmp" /etc/sudoers.d/homeworker-sysupdate
    echo "system-update sudoers installed"
  else
    echo "WARNING: system-update sudoers failed validation; /system_update will not work" >&2
  fi
  rm -f "$tmp"
}

prompt_config() {
  if [ -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/features.json" ]; then
    echo "Configuration exists (.env and features.json found), skipping setup wizard"
    return
  fi

  # Clean up partial state
  rm -f "$INSTALL_DIR/.env.tmp" "$INSTALL_DIR/features.json.tmp"
  if [ -f "$INSTALL_DIR/.env" ]; then
    echo "WARNING: Partial config detected (.env exists without features.json), restarting wizard"
    rm -f "$INSTALL_DIR/.env"
  fi

  echo ""
  echo "============================================"
  echo "  The setup wizard listens only on this device."
  echo "  From your computer, open a second terminal and run:"
  echo "    ssh -L 3000:127.0.0.1:3000 <ssh-user>@<device-host-or-ip>"
  echo "  Keep that SSH session open, then open:"
  echo "    http://127.0.0.1:3000"
  echo "============================================"
  echo ""

  # Fix 6c: Explicit PATH and full env for node execution under homeworker user
  if ! sudo -u "$USER" /usr/bin/env PATH="$PATH:/usr/bin:/usr/local/bin" node "$INSTALL_DIR/scripts/setup-wizard/index.js"; then
    echo "ERROR: Setup wizard failed or timed out"
    exit 1
  fi

  if [ ! -f "$INSTALL_DIR/.env" ]; then
    echo "ERROR: Wizard exited without creating .env"
    exit 1
  fi
}

boot_file() {
  local name="$1"
  if [ -f "/boot/firmware/$name" ]; then
    printf '/boot/firmware/%s\n' "$name"
  else
    printf '/boot/%s\n' "$name"
  fi
}

set_boot_config_var() {
  local key="$1"
  local value="$2"
  local file="$3"

  sudo touch "$file"

  if sudo grep -qE "^[#[:space:]]*${key}=" "$file"; then
    sudo sed -i -E "s|^[#[:space:]]*${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" | sudo tee -a "$file" >/dev/null
  fi
}

remove_serial_console_from_cmdline() {
  local file="$1"
  [ -f "$file" ] || return 0

  sudo cp "$file" "${file}.bak.homeworker.$(date +%s)" || true

  sudo sed -i -E \
    -e 's/(^|[[:space:]])console=(serial0|ttyAMA0|ttyS0|ttyAMA10)(,[^[:space:]]*)?//g' \
    -e 's/[[:space:]]+/ /g' \
    -e 's/^ //' \
    -e 's/ $//' \
    "$file"
}

configure_serial_headless() {
  echo "Configuring UART non-interactively: hardware ON, serial login console OFF..."

  local config_file
  local cmdline_file
  config_file="$(boot_file config.txt)"
  cmdline_file="$(boot_file cmdline.txt)"

  # Bookworm/newer raspi-config path. Values are inverted: 0 = enable, 1 = disable.
  if command -v raspi-config >/dev/null 2>&1; then
    sudo raspi-config nonint do_serial_hw 0 || true
    sudo raspi-config nonint do_serial_cons 1 || true
  fi

  # Hard fallback/enforcement. This prevents a whiptail dialog from being required.
  set_boot_config_var enable_uart 1 "$config_file"
  remove_serial_console_from_cmdline "$cmdline_file"

  # Stop login shells on UART if they were already enabled.
  for svc in \
    serial-getty@serial0.service \
    serial-getty@ttyAMA0.service \
    serial-getty@ttyS0.service \
    serial-getty@ttyAMA10.service
  do
    sudo systemctl disable --now "$svc" 2>/dev/null || true
  done

  echo "UART configured. Reboot required before /dev/serial0 is guaranteed."
}

patch_legacy_feature_serial_calls() {
  [ -d "$INSTALL_DIR/scripts" ] || return 0

  echo "Checking feature installers for legacy raspi-config serial commands..."

  local legacy_files
  local scan_status
  if legacy_files=$(sudo grep -RIlE \
    --exclude='*.bak.serial.*' \
    '^[[:space:]]*(sudo[[:space:]]+)?raspi-config[[:space:]]+nonint[[:space:]]+do_serial[[:space:]]+' \
    "$INSTALL_DIR/scripts" 2>/dev/null); then
    :
  else
    scan_status=$?
    if [ "$scan_status" -eq 1 ]; then
      return 0
    fi
    return "$scan_status"
  fi

  while IFS= read -r file; do
    echo "Patching legacy serial command in: $file"
    sudo cp "$file" "${file}.bak.serial.$(date +%s)" || true

    sudo python3 - "$file" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
text = path.read_text()

# Replace lines like:
#   sudo raspi-config nonint do_serial 2
#   raspi-config nonint do_serial 1 || true
#
# with the noninteractive split commands:
#   sudo raspi-config nonint do_serial_hw 0 || true
#   sudo raspi-config nonint do_serial_cons 1 || true
pattern = re.compile(
    r'(?m)^(\s*)(sudo\s+)?raspi-config\s+nonint\s+do_serial\s+\S+.*$'
)

replacement = (
    r'\1\2raspi-config nonint do_serial_hw 0 || true\n'
    r'\1\2raspi-config nonint do_serial_cons 1 || true'
)

text = pattern.sub(replacement, text)
path.write_text(text)
PY
  done <<< "$legacy_files"
}

install_selected_features() {
  local features_file="$INSTALL_DIR/features.json"
  if [ ! -f "$features_file" ]; then
    return
  fi

  local failed="" successful=""
  local features
  features=$(node -e "try { const f = require(process.argv[1]); const selected = f.enabled || []; const rtspSelected = selected.includes('rtsp'); const allowed = new Set(['digital','uart','zigbee','motion','rtsp']); [...new Set(selected)].filter(n => allowed.has(n) && (n !== 'rtsp' || rtspSelected)).forEach(n => console.log(n)); } catch {}" "$features_file")

  # Wizard selection is only an input. Do not publish any successful state
  # until the fixed root routine and both verifications have completed.
  write_verified_feature_config ""

  while IFS= read -r feature; do
    [ -z "$feature" ] && continue
    echo "Installing dependencies for feature: $feature"
    if HOME_WORKER_PRIVILEGED=1 /usr/lib/home-worker/install-feature-routines "$feature" \
      && /usr/lib/home-worker/feature-installer --verify-feature "$feature" \
      && verify_feature_visible_to_application "$feature"; then
      successful="${successful}${successful:+,}$feature"
      if [ "$feature" = "rtsp" ]; then
        # usermod changes supplementary groups only for new processes. Force the
        # PM2 daemon itself to be recreated later so the worker receives the
        # private homeworker-stream group; before that, runtime adapters fail closed.
        RTSP_GROUP_REFRESH_REQUIRED=1
      fi
    else
      echo "WARNING: Failed to install dependencies for $feature"
      failed="$failed $feature"
    fi
  done <<< "$features"

  write_verified_feature_config "$successful"

  if [ -n "$failed" ]; then
    echo "⚠️ Failed feature installations:$failed (worker will start without these dependencies)"
  fi
}

verify_feature_visible_to_application() {
  local feature="$1"
  # This is intentionally limited to fixed application-owned state. Privileged
  # verification is performed by the root helper; this catches an absent or
  # unreadable configuration boundary before it is seeded as installed.
  sudo -u "$USER" node -e '
    const fs = require("fs");
    const [file, feature] = process.argv.slice(1);
    const stat = fs.statSync(file);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) process.exit(1);
    const env = fs.readFileSync(file, "utf8");
    if (!env.includes("TELEGRAM_BOT_TOKEN=")) process.exit(1);
    if (feature === "rtsp" && !env.includes("LIVE_STREAM_ENABLED=true")) process.exit(1);
  ' "$INSTALL_DIR/.env" "$feature"
}

write_verified_feature_config() {
  local csv="$1"
  sudo -u "$USER" node -e '
    const fs = require("fs");
    const path = require("path");
    const [target, csv] = process.argv.slice(1);
    const enabled = csv ? csv.split(",") : [];
    const payload = JSON.stringify({ enabled, liveStream: enabled.includes("rtsp"), timestamp: new Date().toISOString() }, null, 2) + "\n";
    const directory = path.dirname(target);
    const temporary = path.join(directory, `.features.${process.pid}.${Date.now()}.tmp`);
    let file;
    try {
      file = fs.openSync(temporary, "wx", 0o644);
      fs.writeFileSync(file, payload, "utf8");
      fs.fsyncSync(file);
      fs.closeSync(file); file = undefined;
      fs.renameSync(temporary, target);
      const dir = fs.openSync(directory, "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally {
      if (file !== undefined) fs.closeSync(file);
      try { fs.unlinkSync(temporary); } catch (_) {}
    }
  ' "$INSTALL_DIR/features.json" "$csv"
}

install_feature_management_artifacts() {
  local bundle="/usr/lib/home-worker"
  local source_version="$INSTALL_DIR/config/feature-installer.version"
  local version
  version="$(tr -d '\r\n' < "$source_version" 2>/dev/null || true)"
  if ! [[ "$version" =~ ^[0-9]+$ ]]; then
    echo "ERROR: invalid feature-installer version source" >&2
    exit 1
  fi

  echo "Installing root-owned feature-management boundary..."
  sudo install -d -m 0755 -o root -g root "$bundle" "$bundle/systemd"
  install_root_bundle_file "$INSTALL_DIR/scripts/feature-installer.py" "$bundle/feature-installer" 0755
  install_root_bundle_file "$INSTALL_DIR/scripts/install-feature.sh" "$bundle/install-feature-routines" 0755
  install_root_bundle_file "$INSTALL_DIR/scripts/live-stream-net-helper" "$bundle/live-stream-net-helper" 0755
  install_root_bundle_file "$INSTALL_DIR/scripts/live-stream-ffmpeg-runner" "$bundle/live-stream-ffmpeg-runner" 0755
  for unit in homeworker-feature-install.service homeworker-feature-supervisor-restart.service homeworker-feature-host-reboot.service homeworker-ffmpeg-stream@.service homeworker-stream-net.service homeworker-stream-systemd.rules; do
    install_root_bundle_file "$INSTALL_DIR/systemd/$unit" "$bundle/systemd/$unit" 0644
  done
  install_root_bundle_file "$source_version" "$bundle/feature-installer.version" 0644

  local manifest_tmp
  manifest_tmp="$(mktemp)"
  {
    printf 'version %s\n' "$version"
    for path in "$bundle/feature-installer" "$bundle/install-feature-routines" "$bundle/live-stream-net-helper" "$bundle/live-stream-ffmpeg-runner" \
      "$bundle/systemd/homeworker-feature-install.service" "$bundle/systemd/homeworker-feature-supervisor-restart.service" "$bundle/systemd/homeworker-feature-host-reboot.service" \
      "$bundle/systemd/homeworker-ffmpeg-stream@.service" "$bundle/systemd/homeworker-stream-net.service" "$bundle/systemd/homeworker-stream-systemd.rules"; do
      mode=$(printf '%04o' "0$(stat -c '%a' "$path")")
      digest=$(sha256sum "$path" | awk '{print $1}')
      printf '%s %s %s\n' "$digest" "$mode" "$path"
    done
  } > "$manifest_tmp"
  install_root_bundle_file "$manifest_tmp" "$bundle/feature-installer.manifest" 0644
  rm -f "$manifest_tmp"

  sudo install -d -m 0711 -o root -g root /var/lib/home-worker
  sudo install -d -m 0770 -o root -g "$USER" /var/lib/home-worker/feature-install-requests /var/lib/home-worker/feature-install-results
  sudo install -d -m 0700 -o root -g root /var/lib/home-worker/feature-install-claims
  install_feature_management_sudoers
  for unit in homeworker-feature-install.service homeworker-feature-supervisor-restart.service homeworker-feature-host-reboot.service homeworker-ffmpeg-stream@.service homeworker-stream-net.service; do
    sudo install -m 0644 -o root -g root "$bundle/systemd/$unit" "/etc/systemd/system/$unit"
  done
  sudo systemctl daemon-reload
  /usr/lib/home-worker/feature-installer --validate-installation || { echo "ERROR: root feature helper validation failed" >&2; exit 1; }
}

install_root_bundle_file() {
  local source="$1" target="$2" mode="$3" temporary
  temporary="$(sudo mktemp "${target}.tmp.XXXXXX")"
  sudo install -m "$mode" -o root -g root "$source" "$temporary"
  sudo mv -f "$temporary" "$target"
}

install_feature_management_sudoers() {
  local temporary
  temporary="$(mktemp)"
  cat > "$temporary" <<EOF
$USER ALL=(root) NOPASSWD: /bin/systemctl start --no-block homeworker-feature-install.service, /bin/systemctl start --no-block homeworker-feature-supervisor-restart.service, /bin/systemctl start --no-block homeworker-feature-host-reboot.service
EOF
  if ! sudo visudo -c -f "$temporary" >/dev/null; then
    rm -f "$temporary"
    echo "ERROR: feature-management sudoers validation failed" >&2
    exit 1
  fi
  sudo install -m 0440 -o root -g root "$temporary" /etc/sudoers.d/homeworker-feature-management
  rm -f "$temporary"
}

ensure_motion_video_storage_permissions() {
  local motion_dir="/home/pi/motion/videos"
  local thumbnails_dir="/home/pi/motion/thumbnails"
  if [ ! -d "$motion_dir" ]; then
    return
  fi

  echo "Ensuring Motion media storage permissions..."
  sudo mkdir -p "$thumbnails_dir"
  sudo chmod 755 /home/pi
  if id motion &>/dev/null; then
    sudo chown -R motion:motion /home/pi/motion
  else
    sudo chown -R "$USER:$USER" /home/pi/motion
  fi
  sudo chmod 755 /home/pi/motion
  sudo chmod -R 775 "$motion_dir"
  sudo chmod -R 775 "$thumbnails_dir"
}

database_path() {
  local db_path
  db_path=$(
    sed -n -E 's/^[[:space:]]*DATABASE_PATH[[:space:]]*=[[:space:]]*//p' "$INSTALL_DIR/.env" 2>/dev/null |
    head -1 |
    sed -E 's/[[:space:]]*$//' || true
  )
  case "$db_path" in
    \"*\") db_path="${db_path#\"}"; db_path="${db_path%\"}" ;;
    \'*\') db_path="${db_path#\'}"; db_path="${db_path%\'}" ;;
  esac
  if [ -z "$db_path" ]; then
    db_path="$INSTALL_DIR/data/worker.db"
  fi
  printf '%s\n' "$db_path"
}

motion_feature_enabled() {
  local features_file="$INSTALL_DIR/features.json"
  [ -f "$features_file" ] || return 1

  node -e "try { const f = require(process.argv[1]); process.exit((f.enabled || []).includes('motion') ? 0 : 1); } catch { process.exit(1); }" "$features_file"
}

run_migrations() {
  cd "$INSTALL_DIR"
  local db_path
  db_path="$(database_path)"
  local db_dir
  db_dir="$(dirname "$db_path")"
  sudo mkdir -p "$INSTALL_DIR/data" "$db_dir"
  sudo chown -R "$USER:$USER" "$INSTALL_DIR/data" "$db_dir"
  sudo -u "$USER" corepack yarn db:migrate
  echo "Database migrations applied"
}

seed_motion_camera_metadata() {
  if ! motion_feature_enabled; then
    return
  fi

  cd "$INSTALL_DIR"
  local db_path
  db_path="$(database_path)"
  if [ ! -f "$db_path" ]; then
    echo "WARNING: Database not found at $db_path; skipping Motion camera seed"
    return
  fi

  echo "Ensuring default Motion camera metadata..."
  sudo -u "$USER" sqlite3 "$db_path" <<'SQL'
INSERT OR IGNORE INTO cameras (id, name, type, config, enabled)
SELECT 'front_door_cam', 'front_door_cam', 'motion', NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM cameras WHERE enabled = 1);

UPDATE cameras SET enabled = 1
WHERE (id = 'front_door_cam' OR name = 'front_door_cam')
  AND NOT EXISTS (SELECT 1 FROM cameras WHERE enabled = 1);
SQL
}

setup_pm2() {
  if ! command -v pm2 &>/dev/null; then
    sudo npm install -g pm2
    sudo pm2 install pm2-logrotate
  fi
  cd "$INSTALL_DIR"
  if [ "$RTSP_GROUP_REFRESH_REQUIRED" = "1" ]; then
    echo "Restarting PM2 daemon to refresh RTSP runtime group membership..."
    sudo -u "$USER" pm2 kill 2>/dev/null || true
  fi
  if sudo -u "$USER" pm2 jlist 2>/dev/null | grep -q "\"name\":\"worker\""; then
    echo "Reloading existing PM2 worker process..."
    sudo -u "$USER" pm2 reload ecosystem.config.js 2>/dev/null || sudo -u "$USER" pm2 restart worker
  else
    echo "Starting PM2 worker process..."
    sudo -u "$USER" pm2 start ecosystem.config.js
  fi
  sudo -u "$USER" pm2 save
  sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USER" --hp "/home/$USER"
  echo "PM2 configured with systemd autostart"
}

print_done() {
  cat <<EOF

============================================
  Home Worker installed successfully!
============================================

  Bot is running.
  Use the complete command shown by the setup wizard to become admin.

  Logs:    sudo -u $USER pm2 logs
  Status:  sudo -u $USER pm2 status

EOF
}

reboot_system() {
  echo "Rebooting system to apply changes..."
  sudo reboot
}

if [ "${HOME_WORKER_INSTALL_LIBRARY:-0}" != "1" ]; then
  main "$@"
fi
