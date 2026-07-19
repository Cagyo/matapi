#!/bin/sh
set -eu

echo "Local rollback is available only through the authenticated maintenance workflow." >&2
echo "Use the administrator /rollback command or installer-owned recovery tooling." >&2
exit 64
