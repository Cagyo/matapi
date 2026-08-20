#!/bin/bash

set -euo pipefail

CONFIG="/boot/firmware/config.txt"
BACKUP="${CONFIG}.backup-$(date +%Y%m%d-%H%M%S)"

if [[ $EUID -ne 0 ]]; then
    echo "Run this script with sudo:"
    echo "  sudo $0"
    exit 1
fi

echo "Backing up:"
echo "  $CONFIG"
echo "to:"
echo "  $BACKUP"

cp "$CONFIG" "$BACKUP"

# Remove existing settings we're going to manage.
sed -i \
    -e '/^[[:space:]]*dtparam=fan_temp[0-3]=/d' \
    -e '/^[[:space:]]*dtparam=fan_temp[0-3]_hyst=/d' \
    -e '/^[[:space:]]*dtparam=fan_temp[0-3]_speed=/d' \
    -e '/^[[:space:]]*arm_freq=/d' \
    -e '/^[[:space:]]*arm_freq_min=/d' \
    "$CONFIG"

cat >> "$CONFIG" <<'EOF'

# ------------------------------------------------------------
# Raspberry Pi 5 quiet cooling / dynamic CPU configuration
# ------------------------------------------------------------

[pi5]

# CPU frequency scaling:
# idle/light workloads can drop to 1 GHz,
# while full 2.4 GHz performance remains available.
arm_freq_min=1000
arm_freq=2400

# Fan OFF below 70 C.
# 5 C hysteresis prevents rapid fan on/off cycling.

# ~30%
dtparam=fan_temp0=70000
dtparam=fan_temp0_hyst=5000
dtparam=fan_temp0_speed=75

# ~50%
dtparam=fan_temp1=75000
dtparam=fan_temp1_hyst=5000
dtparam=fan_temp1_speed=125

# ~70%
dtparam=fan_temp2=80000
dtparam=fan_temp2_hyst=5000
dtparam=fan_temp2_speed=175

# ~100%
dtparam=fan_temp3=82500
dtparam=fan_temp3_hyst=5000
dtparam=fan_temp3_speed=250
EOF

echo
echo "Configuration updated successfully."
echo
echo "Backup:"
echo "  $BACKUP"
echo
echo "New configuration:"
echo "  Fan OFF       < 70 C"
echo "  Fan ~30%      >= 70 C"
echo "  Fan ~50%      >= 75 C"
echo "  Fan ~70%      >= 80 C"
echo "  Fan ~100%     >= 82.5 C"
echo "  CPU minimum   1.0 GHz"
echo "  CPU maximum   2.4 GHz"
echo
echo "Reboot to apply:"
echo "  sudo reboot"