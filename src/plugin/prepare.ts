import { generateMacAppsInventory } from './mac-apps-inventory.js'
import type { PluginManifest } from './types.js'

/// Run pre-backup generators for plugins that produce files dynamically.
export async function preparePlugins(plugins: PluginManifest[]): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.prepare === 'mac-apps-inventory') {
      const outputPath = plugin.paths[0]
      if (!outputPath) {
        throw new Error(`Plugin "${plugin.name}" is missing an inventory output path`)
      }
      await generateMacAppsInventory(outputPath)
    }
  }
}
