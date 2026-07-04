#!/bin/bash
set -euo pipefail

# Trap any exit with non-zero status to prevent terminal window from closing immediately
on_exit() {
  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo "" >&2
    echo "❌ Error: dev-deploy.sh terminated with exit code $exit_code." >&2
    echo "Press Enter to close this window..." >&2
    read -r _ || true
  fi
}
trap on_exit EXIT

# Check for required CLI dependencies before running
check_dependencies() {
  local missing=()
  for cmd in sshpass corepack rsync ssh; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if [ ${#missing[@]} -ne 0 ]; then
    echo "❌ Missing required command(s): ${missing[*]}" >&2
    for cmd in "${missing[@]}"; do
      if [ "$cmd" == "sshpass" ]; then
        echo "   -> To install sshpass on macOS via Homebrew: brew install hudochenkov/sshpass/sshpass" >&2
      elif [ "$cmd" == "corepack" ]; then
        echo "   -> To enable/install corepack: corepack enable (or check your Node/Yarn installation)" >&2
      else
        echo "   -> Please ensure '$cmd' is installed and in your PATH." >&2
      fi
    done
    exit 127
  fi
}

check_dependencies

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
