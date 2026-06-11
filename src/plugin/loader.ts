import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { getPluginDir } from './registry.js'
import type { PluginManifest } from './types.js'

export function loadPlugin(name: string): PluginManifest | null {
  const path = resolve(getPluginDir(), `${name}.json`)
  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed.name || !Array.isArray(parsed.paths)) return null
    return parsed as PluginManifest
  } catch {
    return null
  }
}

export function loadAllPlugins(): PluginManifest[] {
  let files: string[] = []
  try {
    files = readdirSync(getPluginDir()).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  return files
    .map((f) => loadPlugin(f.replace(/\.json$/, '')))
    .filter((p): p is PluginManifest => p !== null)
}

export function getEnabledPlugins(pluginNames: string[]): PluginManifest[] {
  return pluginNames
    .map((name) => loadPlugin(name) ?? null)
    .filter((p): p is PluginManifest => p !== null)
}
