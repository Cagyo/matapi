#!/bin/bash
set -euo pipefail

# Trap any exit with non-zero status to prevent terminal window from closing immediately
REMOTE_USER="${REMOTE_USER:-pi}"
REMOTE_HOST="${REMOTE_HOST:-matapitest.local}"
REMOTE_PASS="${REMOTE_PASS:-raspberry}"
SSH_OPTS="-4 -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=/tmp/matapi-dev-deploy-ssh-%r@%h:%p -o ControlPersist=300"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Trap any exit with non-zero status to prevent terminal window from closing immediately
on_exit() {
  local exit_code=$?
  ssh $SSH_OPTS -O exit "$REMOTE_USER@$REMOTE_HOST" 2>/dev/null || true
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
  echo "Removing target directory ~/matapi/worker on $REMOTE_HOST..."
  sshpass -p "$REMOTE_PASS" ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "rm -rf ~/matapi/worker && mkdir -p ~/matapi"
else
  echo "Ensuring target base directory ~/matapi exists on $REMOTE_HOST..."
  sshpass -p "$REMOTE_PASS" ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "mkdir -p ~/matapi"
fi

# Build TypeScript locally off the Pi before deployment
echo "Building TypeScript locally off the Pi..."
corepack yarn build

# Sync worker codebase to development Raspberry Pi
echo "Uploading files to $REMOTE_USER@$REMOTE_HOST:~/matapi..."
sshpass -p "$REMOTE_PASS" rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '.yarn' -e "sshpass -p '$REMOTE_PASS' ssh $SSH_OPTS" "$PROJECT_ROOT" "$REMOTE_USER@$REMOTE_HOST:~/matapi"

# Ensure scripts are executable after upload
echo "Setting executable permissions on scripts..."
sshpass -p "$REMOTE_PASS" ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" 'chmod +x ~/matapi/worker/scripts/*.sh 2>/dev/null || true'

# Run install script on remote host
echo "Running install script on remote host..."
sshpass -p "$REMOTE_PASS" ssh -t $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "cd ~/matapi/worker && echo '$REMOTE_PASS' | sudo -S HOME_WORKER_REPO=\"\$(pwd)\" ./scripts/install.sh"
