#!/bin/bash
set -euo pipefail

REPO="${HOME_WORKER_REPO:-https://github.com/CHANGE_ME/home-worker.git}"
INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-/opt/home-worker}"
NODE_VERSION="${HOME_WORKER_NODE_VERSION:-20}"
USER="${HOME_WORKER_USER:-homeworker}"

export DEBIAN_FRONTEND=noninteractive
export APT_LISTCHANGES_FRONTEND=none
export NEEDRESTART_MODE=a

main() {
  check_raspberry_pi
  setup_hardware_resources
  create_user
  install_system_deps
  install_node
  install_app
  setup_pigpiod
  setup_tmpfs
  prompt_config
  configure_serial_headless
  patch_legacy_feature_serial_calls
  install_selected_features
  run_migrations
  setup_pm2
  print_done
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
    sudo apt-get update -qq || true
    sudo apt-get install -y cloud-guest-utils 2>/dev/null || true

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

install_system_deps() {
  echo "Installing system dependencies..."
  sudo apt-get update
  sudo apt-get install -y \
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
    if sudo apt-get install -y pigpio python3-pigpio; then
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
  sudo apt-get install -y nodejs
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
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Updating existing git installation..."
    if command -v pm2 &>/dev/null; then
      echo "Stopping running PM2 worker instances before update..."
      sudo -u "$USER" pm2 stop ecosystem.config.js 2>/dev/null || true
    fi
    cd "$INSTALL_DIR"
    sudo -u "$USER" git pull origin main
  elif [ -f "$INSTALL_DIR/package.json" ]; then
    echo "Using existing manually deployed application files in $INSTALL_DIR (non-git installation)..."
    if command -v pm2 &>/dev/null; then
      echo "Stopping running PM2 worker instances before update..."
      sudo -u "$USER" pm2 stop ecosystem.config.js 2>/dev/null || true
    fi
    sudo chown -R "$USER:$USER" "$INSTALL_DIR"
  else
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local local_app_root
    local_app_root="$(cd "$script_dir/.." && pwd)"
    local local_source="${REPO#file://}"

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
  install_production_deps
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

  # Fix 1c: Filter hostname -I for IPv4 address
  local IP
  IP=$(hostname -I 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  if [ -z "$IP" ]; then
    IP="localhost"
  fi

  echo ""
  echo "============================================"
  echo "  Open http://$IP:3000 to continue setup"
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

  sudo grep -RIlE 'raspi-config[[:space:]]+nonint[[:space:]]+do_serial([[:space:]]|$)' "$INSTALL_DIR/scripts" 2>/dev/null |
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
  done
}

install_selected_features() {
  local features_file="$INSTALL_DIR/features.json"
  if [ ! -f "$features_file" ]; then
    return
  fi

  local failed=""
  local features
  features=$(node -e "try { const f = require('$features_file'); (f.enabled || []).forEach(n => console.log(n)); } catch {}")

  while IFS= read -r feature; do
    if [ -z "$feature" ]; then continue; fi
    echo "Installing dependencies for feature: $feature"
    if ! "$INSTALL_DIR/scripts/install-feature.sh" "$feature"; then
      echo "WARNING: Failed to install dependencies for $feature"
      failed="$failed $feature"
    fi
  done <<< "$features"

  if [ -n "$failed" ]; then
    echo "⚠️ Failed feature installations:$failed (worker will start without these dependencies)"
  fi
}

run_migrations() {
  cd "$INSTALL_DIR"
  sudo -u "$USER" corepack yarn db:migrate
  echo "Database migrations applied"
}

setup_pm2() {
  if ! command -v pm2 &>/dev/null; then
    sudo npm install -g pm2
    sudo pm2 install pm2-logrotate
  fi
  cd "$INSTALL_DIR"
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
  Send /claim_admin to your bot to become admin.

  Logs:    sudo -u $USER pm2 logs
  Status:  sudo -u $USER pm2 status

EOF
}

main "$@"
