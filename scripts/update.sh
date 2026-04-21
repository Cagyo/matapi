#!/bin/bash
# OTA update — pulls main, installs, builds, runs migrations, restarts.
set -euo pipefail

INSTALL_DIR="${HOME_WORKER_INSTALL_DIR:-/opt/home-worker}"

cd "$INSTALL_DIR"
git fetch origin
git reset --hard origin/main
corepack yarn install --immutable
corepack yarn build
corepack yarn db:migrate
pm2 restart worker
echo "Update complete"
