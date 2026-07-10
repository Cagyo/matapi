#!/bin/bash
set -euo pipefail
FEATURE="${1:-}"
USER="${HOME_WORKER_USER:-homeworker}"

case "$FEATURE" in
  motion)
    echo "Installing motion & ffmpeg dependencies..."
    sudo apt-get install -y motion ffmpeg

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
    sudo apt-get install -y mosquitto mosquitto-clients
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
    sudo apt-get install -y usb-modeswitch
    ;;
  digital|neobox)
    echo "No additional system dependencies required for feature: $FEATURE"
    ;;
  *)
    echo "Unknown feature: $FEATURE" >&2
    exit 1
    ;;
esac
