#!/bin/bash
set -euo pipefail

# Remove target directory before uploading files
echo "Removing target directory ~/matapi/worker on matapitest.local..."
ssh pi@matapitest.local "rm -rf ~/matapi/worker && mkdir -p ~/matapi"

# Sync worker codebase to development Raspberry Pi
echo "Uploading files to pi@matapitest.local:~/matapi..."
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '.yarn' /Users/cagyo/projects/matapi_ai/worker pi@matapitest.local:~/matapi

# Run install script on remote host
echo "Running install script on remote host..."
ssh -t pi@matapitest.local 'cd ~/matapi/worker && sudo HOME_WORKER_REPO="$(pwd)" ./scripts/install.sh'
