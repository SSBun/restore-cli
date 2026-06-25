import { generateHomebrewBrewfile } from './homebrew-inventory.js'
import { generateMacAppsInventory } from './mac-apps-inventory.js'
import { generateRaycastExtensionsInventory } from './raycast-inventory.js'
import type { PluginManifest } from './types.js'
import { generateVSCodeExtensionsInventory } from './vscode-extensions-inventory.js'

export interface PrepareProgressHandlers {
  onPrepareStart?: (pluginName: string, current: number, total: number) => void
  onPrepareDone?: (pluginName: string, current: number, total: number) => void
}

/// Run pre-backup generators for plugins that produce files dynamically.
export async function preparePlugins(
  plugins: PluginManifest[],
  progress?: PrepareProgressHandlers,
): Promise<void> {
  const preparablePlugins = plugins.filter((plugin) => plugin.prepare)
  let prepared = 0

  for (const plugin of plugins) {
    const current = plugin.prepare ? prepared + 1 : prepared
    if (plugin.prepare) {
      progress?.onPrepareStart?.(plugin.name, current, preparablePlugins.length)
    }

    if (plugin.prepare === 'mac-apps-inventory') {
      const outputPath = plugin.paths[0]
      if (!outputPath) {
        throw new Error(`Plugin "${plugin.name}" is missing an inventory output path`)
      }
      await generateMacAppsInventory(outputPath)
    } else if (plugin.prepare === 'homebrew-brewfile') {
      const outputPath = plugin.paths[0]
      if (!outputPath) {
        throw new Error(`Plugin "${plugin.name}" is missing a Brewfile output path`)
      }
      await generateHomebrewBrewfile(outputPath)
    } else if (plugin.prepare === 'raycast-extensions') {
      const outputPath = plugin.paths[0]
      if (!outputPath) {
        throw new Error(`Plugin "${plugin.name}" is missing a Raycast inventory output path`)
      }
      await generateRaycastExtensionsInventory(outputPath)
    } else if (plugin.prepare === 'vscode-extensions-list') {
      const outputPath = plugin.paths[0]
      if (!outputPath) {
        throw new Error(`Plugin "${plugin.name}" is missing a VS Code extensions output path`)
      }
      await generateVSCodeExtensionsInventory(outputPath)
    }

    if (plugin.prepare) {
      prepared++
      progress?.onPrepareDone?.(plugin.name, prepared, preparablePlugins.length)
    }
  }
}
