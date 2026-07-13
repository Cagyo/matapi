#!/bin/bash
set -euo pipefail
FEATURE="${1:-}"
USER="${HOME_WORKER_USER:-homeworker}"
APT_LOCK_TIMEOUT_SECONDS=300
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

apt_get() {
  sudo apt-get -o "DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS}" "$@"
}

install_rtsp_runtime() {
  local stream_user="homeworker-stream"
  local stream_group="homeworker-stream"
  local env_file="$INSTALL_DIR/.env"
  local policy_dir="/etc/home-worker"
  local policy_file="$policy_dir/live-stream-policy.json"

  if ! [[ "$USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
    echo "ERROR: unsafe worker account name" >&2
    return 1
  fi
  apt_get install -y ffmpeg nftables policykit-1
  if ! getent group "$stream_group" >/dev/null; then
    sudo groupadd --system "$stream_group"
  fi
  if ! id "$stream_user" >/dev/null 2>&1; then
    sudo useradd --system --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin --gid "$stream_group" "$stream_user"
  fi
  sudo usermod --home /nonexistent --shell /usr/sbin/nologin --gid "$stream_group" "$stream_user"
  sudo usermod -L "$stream_user"
  sudo usermod -aG "$stream_group" "$USER"

  if ! sudo test -f "$env_file"; then
    echo "ERROR: $env_file is required before RTSP runtime installation" >&2
    return 1
  fi
  # Generate the key only when absent/blank. Existing non-empty keys are never
  # printed or replaced; malformed non-empty values fail closed.
  sudo python3 - "$env_file" "$(id -u "$USER")" <<'PY'
import os, re, secrets, stat, sys, tempfile
path, expected_uid_text = sys.argv[1:]
if not re.fullmatch(r"\d+", expected_uid_text):
    raise SystemExit("unsafe worker uid")
expected_uid = int(expected_uid_text)
try:
    source_fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0))
except OSError:
    raise SystemExit("unsafe env file")
st = os.fstat(source_fd)
if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != expected_uid or stat.S_IMODE(st.st_mode) != 0o600:
    os.close(source_fd)
    raise SystemExit("unsafe env file")
with os.fdopen(source_fd, encoding="utf-8") as stream:
    lines = stream.read().splitlines()
indexes = [i for i, line in enumerate(lines) if line.startswith("RTSP_CREDENTIALS_KEY=")]
if len(indexes) > 1:
    raise SystemExit("duplicate RTSP credential key")
if indexes:
    value = lines[indexes[0]].split("=", 1)[1]
    if value and not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        raise SystemExit("malformed RTSP credential key")
    if value:
        raise SystemExit(0)
    lines[indexes[0]] = "RTSP_CREDENTIALS_KEY=" + secrets.token_hex(32)
else:
    lines.append("RTSP_CREDENTIALS_KEY=" + secrets.token_hex(32))
directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=".env.rtsp.", dir=directory)
try:
    os.fchmod(fd, 0o600)
    os.fchown(fd, expected_uid, st.st_gid)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write("\n".join(lines) + "\n")
        stream.flush(); os.fsync(stream.fileno())
    current = os.lstat(path)
    if current.st_dev != st.st_dev or current.st_ino != st.st_ino:
        raise SystemExit("env file changed during update")
    os.replace(temporary, path)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
PY

  local policy_tmp
  policy_tmp="$(mktemp)"
  if ! sudo python3 - "$env_file" "$policy_tmp" "$(id -u "$USER")" "$(id -u "$stream_user")" <<'PY'
import ipaddress, json, os, re, stat, sys
env_path, output, worker_uid, stream_uid = sys.argv[1:]
if not re.fullmatch(r"\d+", worker_uid) or not re.fullmatch(r"\d+", stream_uid) or worker_uid == stream_uid:
    raise SystemExit("unsafe runtime uid policy")
values = {}
try:
    env_fd = os.open(env_path, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0))
except OSError:
    raise SystemExit("unsafe env file")
env_stat = os.fstat(env_fd)
if not stat.S_ISREG(env_stat.st_mode) or env_stat.st_nlink != 1 or env_stat.st_uid != int(worker_uid) or stat.S_IMODE(env_stat.st_mode) != 0o600:
    os.close(env_fd)
    raise SystemExit("unsafe env file")
with os.fdopen(env_fd, encoding="utf-8") as stream:
    for raw in stream:
        line = raw.rstrip("\r\n")
        if not line or line.startswith("#") or "=" not in line: continue
        key, value = line.split("=", 1)
        if key in values: raise SystemExit("duplicate policy setting")
        values[key] = value.strip().strip('"').strip("'")
cidr_text = values.get("RTSP_ALLOWED_CIDRS", "")
cidrs = [part.strip() for part in cidr_text.split(",") if part.strip()]
if not cidrs: raise SystemExit("RTSP_ALLOWED_CIDRS is required")
canonical = []
for text in cidrs:
    network = ipaddress.ip_network(text, strict=True)
    minimum = 8
    if network.prefixlen < minimum or network.is_global or network.is_multicast or network.is_unspecified:
        raise SystemExit("unsafe RTSP CIDR")
    canonical.append(str(network))
first = int(values.get("RTSP_UDP_PORT_FIRST", "24000"))
last = int(values.get("RTSP_UDP_PORT_LAST", "24001"))
if not (1 <= first <= last <= 65535 and last - first + 1 <= 64):
    raise SystemExit("unsafe RTSP UDP range")
with open(output, "w", encoding="utf-8") as stream:
    json.dump({"version": 1, "workerUid": int(worker_uid), "streamUid": int(stream_uid), "allowedCidrs": canonical, "udpPortFirst": first, "udpPortLast": last}, stream, separators=(",", ":"), sort_keys=True)
    stream.write("\n")
PY
  then
    rm -f "$policy_tmp"
    return 1
  fi

  sudo install -d -m 0755 -o root -g root "$policy_dir" /etc/home-worker/ca /usr/lib/home-worker /etc/polkit-1/rules.d /etc/tmpfiles.d
  sudo install -m 0600 -o root -g root "$policy_tmp" "$policy_file"
  rm -f "$policy_tmp"
  sudo install -m 0755 -o root -g root "$SCRIPT_DIR/live-stream-net-helper" /usr/lib/home-worker/live-stream-net-helper
  sudo install -m 0755 -o root -g root "$SCRIPT_DIR/live-stream-ffmpeg-runner" /usr/lib/home-worker/live-stream-ffmpeg-runner
  sudo install -m 0644 -o root -g root "$INSTALL_DIR/systemd/homeworker-ffmpeg-stream@.service" /etc/systemd/system/homeworker-ffmpeg-stream@.service
  sudo install -m 0644 -o root -g root "$INSTALL_DIR/systemd/homeworker-stream-net.service" /etc/systemd/system/homeworker-stream-net.service
  local polkit_tmp
  polkit_tmp="$(mktemp)"
  sed "s/@HOME_WORKER_USER@/$USER/g" "$INSTALL_DIR/systemd/homeworker-stream-systemd.rules" > "$polkit_tmp"
  sudo install -m 0644 -o root -g root "$polkit_tmp" /etc/polkit-1/rules.d/49-homeworker-stream-systemd.rules
  rm -f "$polkit_tmp"
  local tmpfiles_tmp
  tmpfiles_tmp="$(mktemp)"
  cat > "$tmpfiles_tmp" <<EOF
d /run/home-worker 0750 root $stream_group - -
d /run/home-worker/live-stream-config 2730 root $stream_group - -
d /run/home-worker/live-stream-output 3770 root $stream_group - -
d /run/home-worker/live-source-probe 0700 $USER $USER - -
EOF
  sudo install -m 0644 -o root -g root "$tmpfiles_tmp" /etc/tmpfiles.d/homeworker-stream.conf
  rm -f "$tmpfiles_tmp"
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/homeworker-stream.conf
  sudo systemctl daemon-reload
  sudo systemctl enable homeworker-stream-net.service
  sudo systemctl restart homeworker-stream-net.service
  sudo systemctl is-active --quiet homeworker-stream-net.service
}

case "$FEATURE" in
  motion)
    echo "Installing motion & ffmpeg dependencies..."
    apt_get install -y motion ffmpeg

    # Add user to motion and video groups for shared access
    sudo usermod -aG motion,video "$USER" 2>/dev/null || true

    # Create target media storage directories and make the whole path traversable
    # by the Motion daemon. Some Pi images keep /home/pi at 700 by default.
    sudo mkdir -p /home/pi/motion/videos /home/pi/motion/thumbnails
    sudo chmod 755 /home/pi
    sudo chown -R motion:motion /home/pi/motion 2>/dev/null || sudo chown -R "$USER:$USER" /home/pi/motion
    sudo chmod 755 /home/pi/motion
    sudo chmod -R 775 /home/pi/motion/videos
    sudo chmod -R 775 /home/pi/motion/thumbnails

    # Ensure log directory exists and persist across tmpfs reboots via systemd-tmpfiles
    sudo mkdir -p /var/log/motion
    sudo chown -R motion:motion /var/log/motion 2>/dev/null || true
    if [ -d /etc/tmpfiles.d ]; then
      cat <<EOF | sudo tee /etc/tmpfiles.d/motion.conf >/dev/null
d /var/log/motion 0755 motion motion - -
d /home/pi/motion 0755 motion motion - -
d /home/pi/motion/videos 0775 motion motion - -
d /home/pi/motion/thumbnails 0775 motion motion - -
EOF
      sudo systemd-tmpfiles --create /etc/tmpfiles.d/motion.conf 2>/dev/null || true
    fi

    # Configure /etc/motion/motion.conf
    if [ -f /etc/motion/motion.conf ]; then
      echo "Configuring /etc/motion/motion.conf..."

      set_motion_conf() {
        local key="$1"
        local val="$2"
        if sudo grep -qE "^[#[:space:]]*${key}[[:space:]]+" /etc/motion/motion.conf; then
          sudo sed -i -E "s|^[#[:space:]]*${key}[[:space:]]+.*|${key} ${val}|" /etc/motion/motion.conf
        else
          echo "${key} ${val}" | sudo tee -a /etc/motion/motion.conf >/dev/null
        fi
      }

      set_motion_conf videodevice /dev/video0
      set_motion_conf target_dir /home/pi/motion/videos
      set_motion_conf log_file /var/log/motion/motion.log
      set_motion_conf width 640
      set_motion_conf height 480
      set_motion_conf framerate 8
      # Motion 4.x renamed max_movie_time -> movie_max_time (4.x maps the old
      # name with a warning; 5.x drops it). Migrate any legacy line first.
      sudo sed -i -E 's/^[#[:space:]]*max_movie_time[[:space:]]+.*/movie_max_time 30/' /etc/motion/motion.conf
      set_motion_conf movie_max_time 30
      set_motion_conf movie_output on
      set_motion_conf movie_codec mpeg4
      set_motion_conf movie_filename "%Y/%m/%d/%H%M%S-%{eventid}"
      set_motion_conf picture_output first
      set_motion_conf picture_filename "../thumbnails/%Y/%m/%d/%H%M%S-%{eventid}"
      set_motion_conf stream_port 8081
      set_motion_conf stream_localhost on

      # Spec 20 internal webhooks. Motion runs these via `sh -c`, so the URLs
      # MUST be quoted — an unquoted `&` backgrounds curl and drops `file=%f`.
      # Delete any previous hook definitions, then append fresh quoted hooks.
      sudo sed -i -E '/^[#[:space:]]*on_(event_start|event_end|movie_start|movie_end|picture_save)[[:space:]]/d' /etc/motion/motion.conf
      cat <<'EOF' | sudo tee -a /etc/motion/motion.conf >/dev/null
on_event_start curl -s "http://localhost:4000/motion/event-start?camera=%t"
on_movie_end curl -s "http://localhost:4000/motion/movie-end?camera=%t&file=%f"
on_picture_save curl -s "http://localhost:4000/motion/snapshot?file=%f"
EOF
    fi

    if ! command -v rclone &>/dev/null; then
      curl -sSL https://rclone.org/install.sh | sudo bash
    fi
    # The worker runs rclone as $USER (homeworker), so the remote must live in
    # THAT user's config — not in the home of whoever ran this installer.
    WORKER_HOME="$(getent passwd "$USER" | cut -d: -f6 || true)"
    if [ -z "$WORKER_HOME" ]; then
      echo "ERROR: cannot resolve home directory for user $USER" >&2
      exit 1
    fi
    RCLONE_CONFIG="$WORKER_HOME/.config/rclone/rclone.conf"
    sudo -H -u "$USER" mkdir -p "$WORKER_HOME/.config/rclone"
    sudo -H -u "$USER" chmod 700 "$WORKER_HOME/.config/rclone"
    if sudo -H -u "$USER" env RCLONE_CONFIG="$RCLONE_CONFIG" rclone listremotes 2>/dev/null | grep -q "^gdrive:"; then
      echo "rclone remote 'gdrive:' already configured for $USER."
    else
      echo ""
      echo "⚠️  rclone installed but no 'gdrive:' remote configured for $USER."
      echo "   After install, either:"
      echo "     1. SSH in and run: sudo -H -u $USER env RCLONE_CONFIG=$RCLONE_CONFIG rclone config"
      echo "     2. Or use /gdrive_auth in Telegram to paste config"
      echo ""
    fi
    # sudoers matches command paths as literal strings. On usr-merged Debian
    # (Bookworm) `sudo systemctl` resolves to /usr/bin/systemctl, on older
    # images to /bin/systemctl — list both so the worker's non-interactive
    # `sudo systemctl {start,stop,restart} motion` is never denied. The
    # generated rules live in the dedicated per-feature sudoers file.
    SUDOERS_TMP="$(mktemp)"
    cat > "$SUDOERS_TMP" <<EOF
$USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl start motion, /usr/bin/systemctl stop motion, /usr/bin/systemctl restart motion
$USER ALL=(ALL) NOPASSWD: /bin/systemctl start motion, /bin/systemctl stop motion, /bin/systemctl restart motion
EOF
    if sudo visudo -c -f "$SUDOERS_TMP" >/dev/null; then
      sudo install -m 440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/homeworker-motion
    else
      echo "ERROR: generated sudoers file failed validation; leaving existing rules untouched" >&2
      rm -f "$SUDOERS_TMP"
      exit 1
    fi
    rm -f "$SUDOERS_TMP"
    ;;
  zigbee)
    echo "Installing zigbee dependencies (mosquitto)..."
    apt_get install -y mosquitto mosquitto-clients
    ;;
  uart)
    echo "Configuring UART serial..."
    if command -v raspi-config &>/dev/null; then
      sudo raspi-config nonint do_serial_hw 0 || true
      sudo raspi-config nonint do_serial_cons 1 || true
    fi
    ;;
  4g)
    echo "Installing 4G failover dependencies..."
    apt_get install -y usb-modeswitch
    ;;
  rtsp)
    echo "Installing experimental cloudflared live-stream capability..."
    CLOUDFLARED_ARCH="${HOME_WORKER_DEBIAN_ARCH:-$(dpkg --print-architecture)}"
    case "$CLOUDFLARED_ARCH" in
      amd64|i386|armhf|arm64) ;;
      *)
        echo "ERROR: cloudflared is not supported on Debian architecture: $CLOUDFLARED_ARCH" >&2
        exit 1
        ;;
    esac

    if ! command -v cloudflared >/dev/null 2>&1; then
      CLOUDFLARE_KEYRING_DIR="${CLOUDFLARE_KEYRING_DIR:-/usr/share/keyrings}"
      CLOUDFLARE_SOURCE_LIST_DIR="${CLOUDFLARE_SOURCE_LIST_DIR:-/etc/apt/sources.list.d}"
      CLOUDFLARE_KEYRING="$CLOUDFLARE_KEYRING_DIR/cloudflare-main.gpg"
      CLOUDFLARE_SOURCE_LIST="$CLOUDFLARE_SOURCE_LIST_DIR/cloudflared.list"
      CLOUDFLARE_REPOSITORY="deb [signed-by=$CLOUDFLARE_KEYRING] https://pkg.cloudflare.com/cloudflared any main"

      sudo mkdir -p "$CLOUDFLARE_KEYRING_DIR" "$CLOUDFLARE_SOURCE_LIST_DIR"
      sudo chmod 0755 "$CLOUDFLARE_KEYRING_DIR" "$CLOUDFLARE_SOURCE_LIST_DIR"
      if ! sudo test -s "$CLOUDFLARE_KEYRING"; then
        CLOUDFLARE_KEY_TMP="$(mktemp)"
        if ! curl -fsSL -o "$CLOUDFLARE_KEY_TMP" https://pkg.cloudflare.com/cloudflare-main.gpg; then
          rm -f "$CLOUDFLARE_KEY_TMP"
          echo "ERROR: failed to download the Cloudflare apt signing key." >&2
          exit 1
        fi
        sudo install -m 0644 "$CLOUDFLARE_KEY_TMP" "$CLOUDFLARE_KEYRING"
        rm -f "$CLOUDFLARE_KEY_TMP"
      fi

      CLOUDFLARE_SOURCE_TMP="$(mktemp)"
      printf '%s\n' "$CLOUDFLARE_REPOSITORY" > "$CLOUDFLARE_SOURCE_TMP"
      if ! sudo cmp -s "$CLOUDFLARE_SOURCE_TMP" "$CLOUDFLARE_SOURCE_LIST"; then
        sudo install -m 0644 "$CLOUDFLARE_SOURCE_TMP" "$CLOUDFLARE_SOURCE_LIST"
      fi
      rm -f "$CLOUDFLARE_SOURCE_TMP"

      apt_get update
      apt_get install -y cloudflared
    fi

    CLOUDFLARED_BIN="$(command -v cloudflared)"
    # The installer owns the traversable parent and removes it with sudo. All
    # files below the private worker directory are created by the worker shell.
    DIAG_DIR="$(mktemp -d)"
    cleanup_cloudflared_diagnostics() {
      sudo rm -rf "$DIAG_DIR"
    }
    trap cleanup_cloudflared_diagnostics EXIT
    chmod 711 "$DIAG_DIR"
    DIAG_WORK_DIR="$DIAG_DIR/worker"
    DIAG_HOME="$DIAG_WORK_DIR/home"
    DIAG_CONFIG_DIR="$DIAG_WORK_DIR/config"
    DIAG_CONFIG="$DIAG_CONFIG_DIR/config.yml"
    sudo install -d -m 700 -o "$USER" -g "$USER" \
      "$DIAG_WORK_DIR" "$DIAG_HOME" "$DIAG_CONFIG_DIR"

    set +e
    sudo -H -u "$USER" env -i \
      PATH="/usr/local/bin:/usr/bin:/bin" \
      HOME="$DIAG_HOME" \
      XDG_CONFIG_HOME="$DIAG_CONFIG_DIR" \
      sh -c '
        set -eu
        work_dir="$1"
        config="$2"
        cloudflared_bin="$3"
        cd "$work_dir"
        : > "$config"
        "$cloudflared_bin" --config "$config" version >/dev/null 2>&1 || exit 1
        "$cloudflared_bin" --config "$config" tunnel diag >diagnostic.log 2>&1 || exit 2
      ' sh "$DIAG_WORK_DIR" "$DIAG_CONFIG" "$CLOUDFLARED_BIN"
    DIAG_STATUS=$?
    set -e
    if [ "$DIAG_STATUS" -eq 1 ]; then
      echo "ERROR: cloudflared was installed but its version check failed." >&2
      exit 1
    fi
    if [ "$DIAG_STATUS" -ne 0 ]; then
      echo "WARNING: cloudflared diagnostics failed. Check DNS resolution and outbound port 7844 (QUIC/HTTP2) before using live view." >&2
    fi
    cleanup_cloudflared_diagnostics
    trap - EXIT
    if [ "${HOME_WORKER_RTSP_SKIP_RUNTIME_INSTALL:-0}" = "1" ] && [ "${VITEST:-}" = "true" ]; then
      : # Legacy cloudflared harness exercises only repository/diagnostic behavior.
    else
      install_rtsp_runtime
    fi
    echo "RTSP runtime installed; restart the worker supervisor to refresh its homeworker-stream group membership. Until then RTSP startup remains fail closed."
    echo "Experimental cloudflared live-stream capability installed."
    ;;
  digital|neobox)
    echo "No additional system dependencies required for feature: $FEATURE"
    ;;
  *)
    echo "Unknown feature: $FEATURE" >&2
    exit 1
    ;;
esac
