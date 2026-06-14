import { getBuiltinPlugin, getBuiltinPlugins } from './registry.js'
import type { PluginManifest } from './types.js'

export function getEnabledPlugins(pluginNames: string[]): PluginManifest[] {
  return pluginNames
    .map((name) => getBuiltinPlugin(name) ?? null)
    .filter((p): p is PluginManifest => p !== null)
}

export function getAllPlugins(): PluginManifest[] {
  return getBuiltinPlugins()
}
