import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBuiltinPlugin, getBuiltinPlugins } from './registry.js'
import type { PluginManifest, PluginTool } from './types.js'

export function getPluginScriptsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'scripts')
}

/// Return tools whose script files exist on disk.
export function getAvailableTools(plugin: PluginManifest): PluginTool[] {
  if (!plugin.tools?.length) return []
  return plugin.tools.filter((tool) => resolveToolScriptPath(plugin.name, tool.script) !== null)
}

export function resolveToolScriptPath(pluginName: string, script: string): string | null {
  const scriptPath = resolve(getPluginScriptsDir(), pluginName, script)
  return existsSync(scriptPath) ? scriptPath : null
}

/// Built-in plugins that have at least one available tool script.
export function getPluginsWithAvailableTools(): PluginManifest[] {
  return getBuiltinPlugins().filter((plugin) => getAvailableTools(plugin).length > 0)
}

export function getPluginTool(pluginName: string, toolName: string): PluginTool | null {
  const plugin = getBuiltinPlugin(pluginName)
  if (!plugin) return null
  return getAvailableTools(plugin).find((tool) => tool.name === toolName) ?? null
}
