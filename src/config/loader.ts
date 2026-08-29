import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import JSON5 from 'json5'
import { buildCapturePlan } from '../catalog/scope.js'
import type { CapturePlan } from '../catalog/types.js'
import { getAllPlugins, getUserPluginDirectory } from '../plugin/loader.js'
import type { ResolvedPluginManifest } from '../plugin/types.js'
import { getBackupRoot } from '../util/path.js'
import { type Config, ConfigSchema } from './types.js'

const CONFIG_DIR = resolve(homedir(), '.config', 'restore')
const CONFIG_PATH = resolve(CONFIG_DIR, 'config.json5')

export function getConfigPath(): string {
  return CONFIG_PATH
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH)
}

export type ConfigValidationResult = { ok: true; config: Config } | { ok: false; error: string }

function parseConfigFile(): Config {
  const value = JSON5.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
  return ConfigSchema.parse({ destination: value.destination, plugins: value.plugins })
}

export interface ResolvedBackupConfiguration {
  config: Config
  plugins: ResolvedPluginManifest[]
  plan: CapturePlan
  mirrorPath: string
}

function freezeResolvedInputs(
  plugins: ResolvedPluginManifest[],
  plan: CapturePlan,
): { plugins: ResolvedPluginManifest[]; plan: CapturePlan } {
  for (const plugin of plugins) {
    for (const source of plugin.sources) Object.freeze(source)
    Object.freeze(plugin.sources)
    Object.freeze(plugin.paths)
    Object.freeze(plugin)
  }
  for (const source of plan.sources) Object.freeze(source)
  Object.freeze(plan.sources)
  Object.freeze(plan.plugins)
  Object.freeze(plan)
  Object.freeze(plugins)
  return { plugins, plan }
}

export function resolveBackupConfiguration(
  config: Config,
  options: { pluginDirectory?: string; home?: string } = {},
): ResolvedBackupConfiguration {
  const duplicate = config.plugins.find((name, index) => config.plugins.indexOf(name) !== index)
  if (duplicate) throw new Error(`Plugin is enabled more than once: ${duplicate}`)

  const available = getAllPlugins(options.pluginDirectory ?? getUserPluginDirectory(options.home))
  const byName = new Map(available.map((plugin) => [plugin.name, plugin]))
  const unknown = config.plugins.find((name) => !byName.has(name))
  if (unknown) throw new Error(`Unknown plugin: ${unknown}`)
  const plugins = config.plugins.map((name) => byName.get(name) as ResolvedPluginManifest)
  const mirrorPath = getBackupRoot(config.destination.path)
  const plan = buildCapturePlan(plugins, { home: options.home, forbiddenPaths: [mirrorPath] })
  const secret = plan.sources.find((source) => source.sensitivity === 'secret')
  if (secret) throw new Error(`Readable mirrors do not support secret source: ${secret.id}`)
  return { config, mirrorPath, ...freezeResolvedInputs(plugins, plan) }
}

export function validateConfig(config: Config): Config {
  return resolveBackupConfiguration(config).config
}

export function validateConfigFile(): ConfigValidationResult {
  if (!configExists()) return { ok: false, error: `Config file not found: ${CONFIG_PATH}` }
  try {
    return { ok: true, config: validateConfig(parseConfigFile()) }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

export function loadConfig(): Config {
  if (!configExists()) return getDefaultConfig()
  try {
    return parseConfigFile()
  } catch (error) {
    console.error('Failed to load config, using defaults:', (error as Error).message)
    return getDefaultConfig()
  }
}

export function loadConfigStrict(): Config {
  if (!configExists()) throw new Error('Backup configuration is not initialized')
  return parseConfigFile()
}

export function writeConfig(config: Config): void {
  ensureConfigDir()
  writeFileSync(CONFIG_PATH, JSON5.stringify(ConfigSchema.parse(config), null, 2), 'utf8')
}

export function getDefaultConfig(): Config {
  return ConfigSchema.parse({
    destination: {
      name: 'iCloud',
      path: resolve(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs'),
      type: 'icloud',
    },
    plugins: [],
  })
}
