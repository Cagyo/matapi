#!/bin/bash
# Apply OS-level apt updates. Bot triggers via sudo.
set -euo pipefail

sudo apt-get update
sudo apt-get -y upgrade
echo "System update complete"
