#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_MODULE="$PLUGIN_DIR/mac-apps-inventory.js"

if [[ ! -f "$INVENTORY_MODULE" ]]; then
  echo "Built CLI not found at $INVENTORY_MODULE"
  echo "Run: pnpm build"
  exit 1
fi

node --input-type=module <<EOF
import { generateMacAppsInventory, MAC_APPS_INVENTORY_RELATIVE_PATH } from '${INVENTORY_MODULE}';
await generateMacAppsInventory(MAC_APPS_INVENTORY_RELATIVE_PATH);
console.log('Inventory updated: ~/.config/restore/inventory/mac-apps.json');
EOF
