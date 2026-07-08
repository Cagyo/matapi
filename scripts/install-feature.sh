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

    # Create target video storage directory
    sudo mkdir -p /home/pi/motion/videos
    sudo chown -R motion:motion /home/pi/motion/videos 2>/dev/null || sudo chown -R "$USER:$USER" /home/pi/motion/videos
    sudo chmod -R 775 /home/pi/motion/videos

    # Ensure log directory exists and persist across tmpfs reboots via systemd-tmpfiles
    sudo mkdir -p /var/log/motion
    sudo chown -R motion:motion /var/log/motion 2>/dev/null || true
    if [ -d /etc/tmpfiles.d ]; then
      cat <<EOF | sudo tee /etc/tmpfiles.d/motion.conf >/dev/null
d /var/log/motion 0755 motion motion - -
d /home/pi/motion/videos 0775 motion motion - -
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
      set_motion_conf max_movie_time 30
      set_motion_conf movie_output on
      set_motion_conf movie_filename "%Y/%m/%d/%H%M%S"
      set_motion_conf picture_output on
      set_motion_conf picture_filename "%Y/%m/%d/%H%M%S"
      set_motion_conf stream_port 8081
      set_motion_conf stream_localhost on

      # Spec 20 internal webhooks. Motion runs these via `sh -c`, so the URLs
      # MUST be quoted — an unquoted `&` backgrounds curl and drops `file=%f`.
      # Delete any previous (possibly unquoted) versions, then append fresh.
      sudo sed -i -E '/^on_(event_start|event_end|picture_save) curl -s "?http:\/\/localhost:4000\/motion\//d' /etc/motion/motion.conf
      cat <<'EOF' | sudo tee -a /etc/motion/motion.conf >/dev/null
on_event_start curl -s "http://localhost:4000/motion/event-start?camera=%t"
on_event_end curl -s "http://localhost:4000/motion/event-end?camera=%t&file=%f"
on_picture_save curl -s "http://localhost:4000/motion/snapshot?file=%f"
EOF
    fi

    if ! command -v rclone &>/dev/null; then
      curl -sSL https://rclone.org/install.sh | sudo bash
    fi
    mkdir -p "$HOME/.config/rclone"
    chmod 700 "$HOME/.config/rclone"
    if rclone listremotes 2>/dev/null | grep -q "^gdrive:"; then
      echo "rclone remote 'gdrive:' already configured."
    else
      echo ""
      echo "⚠️  rclone installed but no 'gdrive:' remote configured."
      echo "   After install, either:"
      echo "     1. SSH in and run: rclone config"
      echo "     2. Or use /gdrive_auth in Telegram to paste config"
      echo ""
    fi
    echo "$USER ALL=(ALL) NOPASSWD: /bin/systemctl start motion, /bin/systemctl stop motion, /bin/systemctl restart motion" \
      | sudo tee /etc/sudoers.d/homeworker >/dev/null
    sudo chmod 440 /etc/sudoers.d/homeworker
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
