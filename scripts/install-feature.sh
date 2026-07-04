#!/bin/bash
set -euo pipefail
FEATURE="${1:-}"
USER="${HOME_WORKER_USER:-homeworker}"

case "$FEATURE" in
  motion)
    echo "Installing motion & ffmpeg dependencies..."
    sudo apt-get install -y motion ffmpeg
    sudo mkdir -p /var/lib/motion
    sudo chown -R "$USER:$USER" /var/lib/motion || true
    if ! command -v rclone &>/dev/null; then
      curl -sSL https://rclone.org/install.sh | sudo bash
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
