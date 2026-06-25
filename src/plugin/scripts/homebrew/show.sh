#!/usr/bin/env bash
set -euo pipefail

BREWFILE="${HOME}/.config/restore/inventory/Brewfile"

if [[ ! -f "$BREWFILE" ]]; then
  echo "No Brewfile inventory found at $BREWFILE"
  echo "Run the refresh tool first, or restore-cli backup with homebrew enabled."
  exit 1
fi

cat "$BREWFILE"
