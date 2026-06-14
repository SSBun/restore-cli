#!/usr/bin/env bash
set -euo pipefail

CONFIG="${HOME}/.gitconfig"

if [[ ! -f "$CONFIG" ]]; then
  echo "No ~/.gitconfig found."
  exit 1
fi

cat "$CONFIG"
