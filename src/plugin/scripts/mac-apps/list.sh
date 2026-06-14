#!/usr/bin/env bash
set -euo pipefail

INVENTORY="${HOME}/.config/restore/inventory/mac-apps.json"

if [[ ! -f "$INVENTORY" ]]; then
  echo "No app inventory found at $INVENTORY"
  echo "Enable the mac-apps plugin and run: restore-cli backup"
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  count="$(jq -r '.appCount // 0' "$INVENTORY")"
  generated="$(jq -r '.generatedAt // "unknown"' "$INVENTORY")"
  echo "App inventory ($count apps, generated $generated)"
  echo
  jq -r '.apps[] | [.name, (.version // "-"), (.bundleId // "-"), .path] | @tsv' "$INVENTORY" \
    | column -t -s $'\t'
else
  cat "$INVENTORY"
fi
