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
NODE_VERSION="22"
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
    kill_timeout: 10000,
    max_restarts: 10,      // PM2_MAX_RESTARTS
    min_uptime: 60000,     // PM2_MIN_UPTIME — below this a restart is "unstable"
    restart_delay: 10000,  // PM2_RESTART_DELAY — throttles a crash loop
    env: {
      NODE_ENV: 'production'
    }
  }]
};
```

`min_uptime` is what makes `max_restarts` engage; without it PM2's 1000 ms default lets a fast crash loop run
forever while reporting `online`. `setup_pm2` is one of only two paths that re-evaluate this file — `pm2
restart <name>` and `pm2 resurrect` both replay a stored snapshot — so re-running the installer is how an
operator forces a changed restart policy onto a device immediately. See [23-reliability.md](23-reliability.md)
→ *Crash-Loop Protection* for the values, the delivery paths and the accepted `errored`-instead-of-looping
tradeoff.

### Motion media permissions

`ensure_motion_video_storage_permissions()` runs after feature installation and applies `chmod 711 /home/pi`
**whether or not the camera feature is installed**. It also applies `chmod 755 /home/pi/motion` whenever that
directory exists, so a half-installed media tree cannot move the failure one level deeper; it does nothing at
all when `/home/pi` is absent.

The worker scans `MOTION_LOCAL_DIR` (default `/home/pi/motion/videos`) on every boot regardless of the camera
feature. Raspbian ships `/home/pi` as mode `700`, so without the traversal bit that scan fails with `EACCES` —
an operational error the archive treats as a real fault — instead of `ENOENT`, which it skips silently.

`711`, not `755`: the scan `lstat()`s its root and `readdir()`s from there downwards (`scanBatch`,
`src/camera/infrastructure/fs-completed-motion-video.adapter.ts`), so it needs only the **search** bit on the
directories above its root — never the read bit. The asset being protected is the *human* `pi` account's home,
which on a stock image holds that user's dotfiles and data (`~/.ssh` is `700` in its own right, so key material
is unaffected either way); `711` clears the `EACCES` while keeping `/home/pi` unlistable. It is a narrowing,
not an elimination: a local user who already knows a filename can still traverse to it.

`scripts/install-feature.sh` still applies `755` to the same directory when the camera feature installs. That
is a known divergence, not an oversight — the feature installer is the root-owned, version-pinned helper
bundle, so changing it requires a `config/feature-installer.version` bump and a re-run of the trusted root
installer on every device. Align it there when that file next changes for another reason.

Do **not** "fix" any of this by repointing `MOTION_LOCAL_DIR`: Motion's own `target_dir` is hardcoded to that
path by the feature installer and the feature health checks assert it.

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
3. Wizard: bot token → supported feature selection → feature config
4. Generates `CLAIM_ADMIN_TOKEN`, writes it only to the mode-`0600` `.env`, and writes `features.json`
5. Triggers feature dependency installation per selection, then atomically rewrites `features.json.enabled` to contain only verified successes
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

The initial installer and the runtime `/feature install` workflow use the same fixed per-feature routines. Runtime installation is allowed only through the root-owned, allowlisted helper defined in [the Telegram feature-management design](../superpowers/specs/2026-07-22-telegram-feature-management-design.md). `/feature enable` and `/feature disable` never run package installation. Motion installation does not install or alter a separate Drive utility or inspect user cloud configuration.

### Immutable archive installation state

Before the application starts, `install.sh` creates `/etc/home-worker` as
`root:homeworker` mode `0750`. It publishes `archive.key` and `installation-id`
atomically only when absent. The archive key is exactly 32 random bytes; both
files are `root:homeworker` mode `0640`, regular, non-link, single-link files.
Every reinstall and OTA validates type, link count, owner, group, mode, size,
and value shape. Existing paths, including symlinks and malformed files, are
rejected rather than replaced. The installer never reads or modifies a user's
cloud-client configuration.
