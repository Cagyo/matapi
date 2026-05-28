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
}

check_raspberry_pi() {
  if ! grep -q "Raspberry Pi" /proc/cpuinfo 2>/dev/null; then
    echo "WARNING: Not running on Raspberry Pi. Continuing anyway (dev mode)."
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
    git sqlite3 libsqlite3-dev \
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
  sudo -u "$USER" corepack yarn install --immutable
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
  sudo -u "$USER" pm2 start ecosystem.config.js
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
  echo "  Send /claim_admin to your bot to become admin."
  echo ""
  echo "  Logs: sudo -u $USER pm2 logs"
  echo "  Status: sudo -u $USER pm2 status"
  echo ""
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
2. Starts `scripts/setup-wizard/index.ts` on `:3000`
3. Wizard: bot token → feature selection → feature config
4. Writes `.env` + `features.json`
5. Triggers feature dep installation per selection
6. Starts NestJS worker, shuts itself down
7. Final page: "Send /claim_admin to your bot"

### Feature Installation at Install Time

```bash
install_feature() {
  case $1 in
    motion)
      sudo apt-get install -y motion
      mkdir -p /var/lib/motion
      # Install rclone
      curl https://rclone.org/install.sh | sudo bash
      # Configure sudoers for motion control
      echo "$USER ALL=(ALL) NOPASSWD: /bin/systemctl start motion, /bin/systemctl stop motion, /bin/systemctl restart motion" \
        | sudo tee /etc/sudoers.d/homeworker
      ;;
    zigbee)
      # Install mosquitto
      sudo apt-get install -y mosquitto mosquitto-clients
      # Install zigbee2mqtt (from npm or official installer)
      ;;
    uart)
      # Enable serial port
      sudo raspi-config nonint do_serial 2  # enable UART, disable console
      ;;
  esac
}
```

Bot `/feature enable/disable` only toggles pre-installed features. Does not install deps at runtime.
