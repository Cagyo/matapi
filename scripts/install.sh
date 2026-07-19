#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
MIGRATOR="$SCRIPT_DIR/migrate-to-signed-ota.sh"

case "$#:$*" in
  "1:--fresh"|"2:--migrate --confirm")
    exec "$MIGRATOR" "$@"
    ;;
  *)
    echo "Usage: scripts/install.sh --fresh | --migrate --confirm" >&2
    exit 64
    ;;
esac
