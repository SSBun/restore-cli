#!/usr/bin/env bash
set -euo pipefail

INVENTORY="${HOME}/.config/restore/inventory/mac-apps.json"

if [[ ! -f "$INVENTORY" ]]; then
  echo "No app inventory found."
  echo "Run the refresh tool first, or restore-cli backup with mac-apps enabled."
  exit 1
fi

if command -v open >/dev/null 2>&1; then
  open -R "$INVENTORY"
else
  echo "$INVENTORY"
fi
