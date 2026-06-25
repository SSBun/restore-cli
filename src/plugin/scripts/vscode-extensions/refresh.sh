#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_MODULE="$PLUGIN_DIR/vscode-extensions-inventory.js"

if [[ ! -f "$INVENTORY_MODULE" ]]; then
  echo "Built CLI not found at $INVENTORY_MODULE"
  echo "Run: pnpm build"
  exit 1
fi

node --input-type=module <<EOF
import { generateVSCodeExtensionsInventory, VSCODE_EXTENSIONS_RELATIVE_PATH } from '${INVENTORY_MODULE}';
const output = await generateVSCodeExtensionsInventory(VSCODE_EXTENSIONS_RELATIVE_PATH);
console.log(\`VS Code extensions inventory updated: \${output}\`);
EOF
