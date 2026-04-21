#!/bin/bash
set -euo pipefail

REPO="${HOME_WORKER_REPO:-https://github.com/CHANGE_ME/home-worker.git}"
INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-/opt/home-worker}"
NODE_VERSION="${HOME_WORKER_NODE_VERSION:-20}"
USER="${HOME_WORKER_USER:-homeworker}"

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
    sudo useradd -r -m -s /bin/bash "$USER"
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
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "Node.js installed: $(node -v)"
  # Enable corepack so the yarn version pinned in package.json is used.
  sudo corepack enable
}

install_app() {
  if [ -d "$INSTALL_DIR/.git" ]; then
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
  sudo -u "$USER" corepack yarn build
}

setup_pigpiod() {
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
  if [ -f "$INSTALL_DIR/.env" ]; then
    echo ".env already exists, skipping config"
    return
  fi
  read -rp "Telegram Bot Token: " BOT_TOKEN
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$BOT_TOKEN|" "$INSTALL_DIR/.env"
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
