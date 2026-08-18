#!/bin/bash
# Capture real libgpiod CLI output into test/fixtures/gpio/<dir>.
# Run on a real Pi as the worker user (needs gpio group membership).
# The offset must be a configured-but-unwired pin; generating gpiomon events
# requires briefly shorting that pin to GND with a jumper when prompted.
set -euo pipefail

OUT="${1:?usage: capture-gpio-fixtures.sh <output-dir> <chip> <unwired-offset>}"
CHIP="${2:?chip name, e.g. gpiochip0}"
OFFSET="${3:?unwired BCM offset, e.g. 26}"
mkdir -p "$OUT"

gpiodetect --version | tee "$OUT/version.txt"
gpiodetect | tee "$OUT/gpiodetect.txt"

MAJOR="$(sed -n -E 's/.*v?([0-9]+)\.[0-9].*/\1/p' "$OUT/version.txt" | head -1)"

if [ "$MAJOR" = "2" ]; then
  gpioget --chip "$CHIP" --numeric --bias=pull-down "$OFFSET" | tee "$OUT/gpioget.txt"
else
  gpioget --bias=pull-down "$CHIP" "$OFFSET" | tee "$OUT/gpioget.txt"
fi

# gpioinfo while a monitor holds the line (consumer field is the attach signal).
if [ "$MAJOR" = "2" ]; then
  stdbuf -oL gpiomon --chip "$CHIP" --bias=pull-up "--consumer=home-worker-$OFFSET" --format=%e "$OFFSET" > "$OUT/gpiomon-events.txt" &
else
  stdbuf -oL gpiomon --bias=pull-up --format=%e "$CHIP" "$OFFSET" > "$OUT/gpiomon-events.txt" &
fi
MON=$!
sleep 0.5
if [ "$MAJOR" = "2" ]; then
  gpioinfo --chip "$CHIP" | tee "$OUT/gpioinfo.txt"
else
  gpioinfo "$CHIP" | tee "$OUT/gpioinfo.txt"
fi

echo ""
echo ">>> Briefly short BCM $OFFSET to GND with a jumper a couple of times,"
echo ">>> then press Enter."
read -r
kill "$MON" 2>/dev/null || true
wait "$MON" 2>/dev/null || true
echo "Captured events:"
cat "$OUT/gpiomon-events.txt"
echo "Done. Commit the fixture diff and update test/fixtures/gpio/PROVENANCE.md."
