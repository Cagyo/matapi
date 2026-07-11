# 25 — Installation

## Dependencies
- 00-overview.md (.env, project structure)
- 01-database.md (migrations)

## Phase 0 — Simple Install Script

```bash
curl -sSL https://raw.githubusercontent.com/<user>/<repo>/main/scripts/install.sh | bash
```

### Script Structure

Idempotent — safe to re-run. Each function checks current state.

```bash
#!/bin/bash
set -euo pipefail

REPO="https://github.com/<user>/home-worker.git"
INSTALL_DIR="/opt/home-worker"
NODE_VERSION="20"
USER="homeworker"

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
  run_migrations
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
  echo "Tuning kernel memory behavior (vm.swappiness=10)..."
  sudo sysctl -w vm.swappiness=10 2>/dev/null || true
  if [ -f /etc/sysctl.conf ] && ! grep -q "vm.swappiness" /etc/sysctl.conf; then
    echo "vm.swappiness=10" | sudo tee -a /etc/sysctl.conf >/dev/null || true
  fi

  local total_mem total_swap
  total_mem=$(free -m | awk '/^Mem:/{print $2}' || echo 0)
  total_swap=$(free -m | awk '/^Swap:/{print $2}' || echo 0)
  if [ "$((total_mem + total_swap))" -lt 2048 ]; then
    echo "Configuring 2GB persistent swapfile..."
    if command -v dphys-swapfile >/dev/null 2>&1; then
      sudo dphys-swapfile swapoff 2>/dev/null || true
      sudo systemctl disable --now dphys-swapfile 2>/dev/null || true
    fi
    if [ ! -f /swapfile ]; then
      sudo fallocate -l 2G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
      sudo chmod 600 /swapfile
      sudo mkswap /swapfile
    fi
    sudo swapon /swapfile 2>/dev/null || true
    if [ -f /etc/fstab ] && ! grep -q "/swapfile" /etc/fstab; then
      echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
    fi
  fi
}

create_user() {
  if ! id "$USER" &>/dev/null; then
    sudo useradd -r -s /bin/false "$USER"
    echo "Created system user: $USER"
  fi
}

install_system_deps() {
  echo "Installing system dependencies..."
  sudo apt-get update
  sudo apt-get install -y \
    git sqlite3 libsqlite3-dev build-essential python3 python3-setuptools \
    pigpio python3-pigpio \
    ffmpeg \
    usb-modeswitch
}

install_node() {
  if command -v node &>/dev/null; then
    CURRENT=$(node -v | cut -d'.' -f1 | tr -d 'v')
    if [ "$CURRENT" = "$NODE_VERSION" ]; then
      echo "Node.js $NODE_VERSION already installed: $(node -v)"
      return
    fi
  fi
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
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
  if [ -d "$INSTALL_DIR" ]; then
    echo "Updating existing installation..."
    cd "$INSTALL_DIR"
    sudo -u "$USER" git pull origin main
  else
    echo "Cloning repository..."
    sudo git clone "$REPO" "$INSTALL_DIR"
    sudo chown -R "$USER:$USER" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
  install_production_deps
}

setup_pigpiod() {
  sudo systemctl enable pigpiod
  sudo systemctl start pigpiod
  echo "pigpiod enabled and started"
}

setup_tmpfs() {
  # Mount /tmp and /var/log as tmpfs to reduce SD card writes
  if ! grep -q "tmpfs /tmp" /etc/fstab; then
    echo "tmpfs /tmp tmpfs defaults,noatime,nosuid,size=100m 0 0" | sudo tee -a /etc/fstab
    echo "tmpfs /var/log tmpfs defaults,noatime,nosuid,size=50m 0 0" | sudo tee -a /etc/fstab
    echo "tmpfs entries added to /etc/fstab (effective after reboot)"
  fi
}

prompt_config() {
  if [ -f "$INSTALL_DIR/.env" ]; then
    echo ".env already exists, skipping config"
    return
  fi

  read -rp "Telegram Bot Token: " BOT_TOKEN

  # Copy defaults and set token
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  sed -i "s/^TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=$BOT_TOKEN/" "$INSTALL_DIR/.env"

  sudo chown "$USER:$USER" "$INSTALL_DIR/.env"
  sudo chmod 600 "$INSTALL_DIR/.env"
  echo ".env configured"
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
    sudo -u "$USER" pm2 reload ecosystem.config.js 2>/dev/null || sudo -u "$USER" pm2 restart worker
  else
    sudo -u "$USER" pm2 start ecosystem.config.js
  fi
  sudo -u "$USER" pm2 save
  sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u "$USER" --hp "/home/$USER"

  echo "PM2 configured with systemd autostart"
}

print_done() {
  echo ""
  echo "============================================"
  echo "  Home Worker installed successfully!"
  echo "============================================"
  echo ""
  echo "  Bot is running."
  echo "  Use the complete command shown by the setup wizard to become admin."
  echo ""
  echo "  Logs: sudo -u $USER pm2 logs"
  echo "  Status: sudo -u $USER pm2 status"
  echo ""
}

reboot_system() {
  echo "Rebooting system to apply changes..."
  sudo reboot
}

main "$@"
```

### ecosystem.config.js

```javascript
module.exports = {
  apps: [{
    name: 'worker',
    script: 'dist/main.js',
    cwd: '/opt/home-worker',
    instances: 1,
    max_memory_restart: '512M',
    max_restarts: 10,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
```

### .gitignore (must include)

```
.env
node_modules/
dist/
data/
*.db
```

### Pre-commit Hook

```bash
#!/bin/sh
# .git/hooks/pre-commit
if git diff --cached --name-only | grep -q "^\.env$"; then
  echo "ERROR: .env file should not be committed!"
  exit 1
fi
```

Install script should set up this hook automatically.

## Phase 1 — Setup Web Wizard

Standalone lightweight HTTP server (not NestJS):

1. Install script runs unattended (no prompts)
2. Starts `scripts/setup-wizard/index.js` on loopback-only `127.0.0.1:3000`
3. Wizard: bot token → feature selection → feature config
4. Generates `CLAIM_ADMIN_TOKEN`, writes it only to the mode-`0600` `.env`, and writes `features.json`
5. Triggers feature dep installation per selection
6. Starts NestJS worker, shuts itself down
7. Final page shows `/claim_admin <claim-token>` once; the installer never reads or prints the token

The loopback binding is intentional: the setup server is not a LAN service.
At startup it displays a one-time pairing secret only on the terminal that
launched the installer. The secret is never placed in the setup URL or wizard
logs. Each state-changing setup request must present that secret; requests
without it are rejected before token validation or configuration writes.

Client-side token validation is only a convenience. The server validates the
bot token again on the final submission and writes configuration only when that
fresh validation returns a cleaned token. A value supplied by the browser is
never trusted for the final write on its own.

### Remote setup over SSH

The wizard is intentionally reachable only from the Raspberry Pi itself. From
your workstation, create a loopback tunnel before opening the setup page:

```bash
ssh -L 3000:127.0.0.1:3000 <pi-user>@<pi-host>
```

Run the installer from that interactive SSH terminal. The wizard prints a
one-time pairing secret only to that terminal; enter the secret into the first
field at `http://127.0.0.1:3000`, then enter the Telegram bot token. Keep the
SSH session open until setup completes. The pairing secret is never included in
the setup URL or logged by the wizard. The server checks the pairing secret on
every state-changing setup request and performs a fresh final token validation
before it writes the `.env` or feature configuration.

### Feature Installation at Install Time

```bash
install_feature() {
  case $1 in
    motion)
      sudo apt-get install -y motion
      mkdir -p /home/pi/motion/videos
      # Install rclone
      curl https://rclone.org/install.sh | sudo bash
      # Configure sudoers for motion control
      SUDOERS_TMP="$(mktemp)"
      cat > "$SUDOERS_TMP" <<'EOF'
homeworker ALL=(ALL) NOPASSWD: /usr/bin/systemctl start motion, /usr/bin/systemctl stop motion, /usr/bin/systemctl restart motion
homeworker ALL=(ALL) NOPASSWD: /bin/systemctl start motion, /bin/systemctl stop motion, /bin/systemctl restart motion
EOF
      if sudo visudo -c -f "$SUDOERS_TMP"; then
        sudo install -m 440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/homeworker-motion
      else
        echo "ERROR: generated sudoers file failed validation; leaving existing rules untouched" >&2
        rm -f "$SUDOERS_TMP"
        exit 1
      fi
      rm -f "$SUDOERS_TMP"
      ;;
    zigbee)
      # Install mosquitto
      sudo apt-get install -y mosquitto mosquitto-clients
      # Install zigbee2mqtt (from npm or official installer)
      ;;
    uart)
      # Enable serial port (enable UART hardware, disable login console)
      sudo raspi-config nonint do_serial_hw 0 || true
      sudo raspi-config nonint do_serial_cons 1 || true
      ;;
  esac
}
```

Bot `/feature enable/disable` only toggles pre-installed features. Does not install deps at runtime.
