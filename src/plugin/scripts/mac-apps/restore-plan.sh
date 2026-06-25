#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_MODULE="$PLUGIN_DIR/mac-apps-inventory.js"
INVENTORY="${HOME}/.config/restore/inventory/mac-apps.json"

if [[ ! -f "$INVENTORY" ]]; then
  echo "No app inventory found at $INVENTORY"
  echo "Run the refresh tool first, or restore-cli backup with mac-apps enabled."
  exit 1
fi

if [[ ! -f "$INVENTORY_MODULE" ]]; then
  echo "Built CLI not found at $INVENTORY_MODULE"
  echo "Run: pnpm build"
  exit 1
fi

node --input-type=module <<EOF
import { formatMacAppsRestorePlan, generateMacAppsRestorePlan } from '${INVENTORY_MODULE}';
const plan = await generateMacAppsRestorePlan('${INVENTORY}');
process.stdout.write(formatMacAppsRestorePlan(plan));
EOF
