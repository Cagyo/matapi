#!/bin/bash
set -euo pipefail

RESET="${RESET:-false}"
for arg in "$@"; do
  if [[ "$arg" == "--reset" || "$arg" == "-r" ]]; then
    RESET="true"
  fi
done

if [[ "$RESET" == "true" ]]; then
  echo "Removing target directory ~/matapi/worker on matapitest.local..."
  sshpass -p "raspberry" ssh pi@matapitest.local "rm -rf ~/matapi/worker && mkdir -p ~/matapi"
else
  echo "Ensuring target base directory ~/matapi exists on matapitest.local..."
  sshpass -p "raspberry" ssh pi@matapitest.local "mkdir -p ~/matapi"
fi

# Build TypeScript locally off the Pi before deployment
echo "Building TypeScript locally off the Pi..."
corepack yarn build

# Sync worker codebase to development Raspberry Pi
echo "Uploading files to pi@matapitest.local:~/matapi..."
sshpass -p "raspberry" rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '.yarn' -e 'sshpass -p "raspberry" ssh' /Users/cagyo/projects/matapi_ai/worker pi@matapitest.local:~/matapi

# Ensure scripts are executable after upload
echo "Setting executable permissions on scripts..."
sshpass -p "raspberry" ssh pi@matapitest.local 'chmod +x ~/matapi/worker/scripts/*.sh 2>/dev/null || true'

# Run install script on remote host
echo "Running install script on remote host..."
sshpass -p "raspberry" ssh -t pi@matapitest.local 'cd ~/matapi/worker && echo "raspberry" | sudo -S HOME_WORKER_REPO="$(pwd)" ./scripts/install.sh'
