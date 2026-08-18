#!/bin/bash
# On-device GPIO smoke test (run from the install path, as the worker user).
#
#   gpio-smoke.sh <unwired-offset>              — bias plumbing + permissions
#   gpio-smoke.sh <monitor-offset> <drive-offset>  — + event latency (<100 ms),
#     with a jumper wired between the two BCM offsets.
#
# Bias check: a configured-but-unwired pin must read 1 under pull-up and 0
# under pull-down. Latency check: gpioset on the driven pin must reach a
# stdbuf-piped gpiomon on the monitored pin within 100 ms.
set -euo pipefail

OFFSET="${1:?usage: gpio-smoke.sh <unwired-bcm-offset> [drive-bcm-offset]}"
DRIVE="${2:-}"

CHIP="${GPIO_CHIP:-}"
if [ -z "$CHIP" ]; then
  for label in pinctrl-bcm2835 pinctrl-bcm2711 pinctrl-rp1; do
    CHIP="$(gpiodetect | sed -n -E "s/^(\S+) \[$label\].*/\1/p" | head -1)"
    [ -n "$CHIP" ] && break
  done
fi
[ -n "$CHIP" ] || { echo "FAIL: no known GPIO chip label found (gpiodetect output follows)"; gpiodetect; exit 1; }

MAJOR="$(gpiodetect --version | sed -n -E 's/.*v?([0-9]+)\.[0-9].*/\1/p' | head -1)"
echo "chip=$CHIP libgpiod-major=$MAJOR"

get() { # get <bias>
  if [ "$MAJOR" = "2" ]; then
    gpioget --chip "$CHIP" --numeric "--bias=$1" "$OFFSET"
  else
    gpioget "--bias=$1" "$CHIP" "$OFFSET"
  fi
}

UP="$(get pull-up)"
DOWN="$(get pull-down)"
if [ "$UP" = "1" ] && [ "$DOWN" = "0" ]; then
  echo "PASS: bias plumbing (offset $OFFSET reads $UP with pull-up, $DOWN with pull-down)"
else
  echo "FAIL: pull-up read '$UP', pull-down read '$DOWN' — expected 1 then 0. Is the pin wired, or permissions missing?" >&2
  exit 1
fi

[ -z "$DRIVE" ] && { echo "Done (no drive offset given; latency check skipped)."; exit 0; }

EVENTS="$(mktemp)"
trap 'kill "${MON:-}" 2>/dev/null || true; rm -f "$EVENTS"' EXIT
if [ "$MAJOR" = "2" ]; then
  stdbuf -oL gpiomon --chip "$CHIP" --bias=pull-down --format=%e "$OFFSET" > "$EVENTS" &
else
  stdbuf -oL gpiomon --bias=pull-down --format=%e "$CHIP" "$OFFSET" > "$EVENTS" &
fi
MON=$!
sleep 0.5

START_NS="$(date +%s%N)"
if [ "$MAJOR" = "2" ]; then
  timeout 1 gpioset --chip "$CHIP" "$DRIVE=1" || true
else
  gpioset --mode=time --sec=1 "$CHIP" "$DRIVE=1" || true
fi

DEADLINE=$((START_NS + 1000000000))
while [ ! -s "$EVENTS" ]; do
  NOW="$(date +%s%N)"
  [ "$NOW" -gt "$DEADLINE" ] && { echo "FAIL: no event within 1s — check the jumper $DRIVE -> $OFFSET" >&2; exit 1; }
done
END_NS="$(date +%s%N)"
LATENCY_MS=$(( (END_NS - START_NS) / 1000000 ))

if [ "$LATENCY_MS" -lt 100 ]; then
  echo "PASS: piped event latency ${LATENCY_MS}ms (< 100ms — stdbuf assumption holds)"
else
  echo "FAIL: piped event latency ${LATENCY_MS}ms (>= 100ms — investigate gpiomon buffering)" >&2
  exit 1
fi
