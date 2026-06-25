#!/usr/bin/env bash
set -euo pipefail

INVENTORY="${HOME}/.config/restore/inventory/vscode-extensions.txt"

if [[ ! -f "$INVENTORY" ]]; then
  echo "No VS Code extensions inventory found at $INVENTORY"
  echo "Run the refresh tool first, or restore-cli backup with vscode-extensions enabled."
  exit 1
fi

cat "$INVENTORY"
