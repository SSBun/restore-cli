#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_MODULE="$PLUGIN_DIR/homebrew-inventory.js"

if [[ ! -f "$INVENTORY_MODULE" ]]; then
  echo "Built CLI not found at $INVENTORY_MODULE"
  echo "Run: pnpm build"
  exit 1
fi

node --input-type=module <<EOF
import { generateHomebrewBrewfile, HOMEBREW_BREWFILE_RELATIVE_PATH } from '${INVENTORY_MODULE}';
const output = await generateHomebrewBrewfile(HOMEBREW_BREWFILE_RELATIVE_PATH);
console.log(\`Brewfile updated: \${output}\`);
EOF
