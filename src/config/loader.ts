import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import JSON5 from 'json5'
import { buildCapturePlan, sourceContractFingerprint } from '../catalog/scope.js'
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
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH)
}

export type ConfigValidationResult = { ok: true; config: Config } | { ok: false; error: string }

function parseConfigFile(): Config {
  const raw = readFileSync(CONFIG_PATH, 'utf-8')
  const parsed = JSON5.parse(raw)
  return ConfigSchema.parse(parsed)
}

export function validateConfig(
  config: Config,
  options: { pluginDirectory?: string; home?: string } = {},
): Config {
  return resolveBackupConfiguration(config, options).config
}

export interface ResolvedBackupConfiguration {
  config: Config
  plugins: ResolvedPluginManifest[]
  plan: CapturePlan
  repositoryPath: string
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
  for (const plugin of plan.plugins) {
    Object.freeze(plugin.sources)
    Object.freeze(plugin.paths)
    Object.freeze(plugin)
  }
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
  const duplicatePlugin = config.plugins.find(
    (plugin, index) => config.plugins.indexOf(plugin) !== index,
  )
  if (duplicatePlugin) throw new Error(`Plugin is enabled more than once: ${duplicatePlugin}`)

  const available = getAllPlugins(options.pluginDirectory ?? getUserPluginDirectory(options.home))
  const byName = new Map(available.map((plugin) => [plugin.name, plugin]))
  const unknown = config.plugins.find((plugin) => !byName.has(plugin))
  if (unknown) throw new Error(`Unknown plugin: ${unknown}`)
  const plugins = config.plugins.map((plugin) => byName.get(plugin) as ResolvedPluginManifest)
  const repositoryPath = getBackupRoot(config.destination.path)
  const plan = buildCapturePlan(plugins, {
    home: options.home,
    forbiddenPaths: [repositoryPath],
  })

  const acceptanceIds = new Set<string>()
  for (const acceptance of config.plaintextSecretAcceptances ?? []) {
    const key = `${acceptance.repositoryId}:${acceptance.sourceId}`
    if (acceptanceIds.has(key)) {
      throw new Error(`Plaintext secret acceptance is duplicated: ${acceptance.sourceId}`)
    }
    acceptanceIds.add(key)
  }

  if (config.repository?.protection === 'plaintext') {
    const validAcceptances = new Set(
      plan.sources
        .filter((source) => source.sensitivity === 'secret')
        .map(
          (source) => `${config.repository?.id}:${source.id}:${sourceContractFingerprint(source)}`,
        ),
    )
    for (const source of plan.sources.filter((source) => source.sensitivity === 'secret')) {
      const accepted = (config.plaintextSecretAcceptances ?? []).some(
        (acceptance) =>
          acceptance.repositoryId === config.repository?.id &&
          acceptance.sourceId === source.id &&
          acceptance.sourceContractFingerprint === sourceContractFingerprint(source),
      )
      if (!accepted) {
        throw new Error(
          `Plaintext repository requires independent acceptance for secret source: ${source.id}`,
        )
      }
    }
    for (const acceptance of config.plaintextSecretAcceptances ?? []) {
      if (acceptance.repositoryId !== config.repository.id) continue
      const key = `${acceptance.repositoryId}:${acceptance.sourceId}:${acceptance.sourceContractFingerprint}`
      if (!validAcceptances.has(key)) {
        throw new Error(`Plaintext secret acceptance is stale or orphaned: ${acceptance.sourceId}`)
      }
    }
  }
  return { config, ...freezeResolvedInputs(plugins, plan), repositoryPath }
}

export function prunePlaintextSecretAcceptances(
  config: Config,
  options: { pluginDirectory?: string; home?: string } = {},
): Config {
  if (config.repository?.protection !== 'plaintext') return config
  const available = getAllPlugins(options.pluginDirectory ?? getUserPluginDirectory(options.home))
  const byName = new Map(available.map((plugin) => [plugin.name, plugin]))
  const plugins = config.plugins.flatMap((name) => {
    const plugin = byName.get(name)
    return plugin ? [plugin] : []
  })
  const plan = buildCapturePlan(plugins, {
    home: options.home,
    forbiddenPaths: [getBackupRoot(config.destination.path)],
  })
  const valid = new Set(
    plan.sources
      .filter((source) => source.sensitivity === 'secret')
      .map(
        (source) => `${config.repository?.id}:${source.id}:${sourceContractFingerprint(source)}`,
      ),
  )
  return {
    ...config,
    plaintextSecretAcceptances: (config.plaintextSecretAcceptances ?? []).filter(
      (acceptance) =>
        acceptance.repositoryId !== config.repository?.id ||
        valid.has(
          `${acceptance.repositoryId}:${acceptance.sourceId}:${acceptance.sourceContractFingerprint}`,
        ),
    ),
  }
}

export function validateConfigFile(): ConfigValidationResult {
  if (!configExists()) {
    return { ok: false, error: `Config file not found: ${CONFIG_PATH}` }
  }

  try {
    return { ok: true, config: validateConfig(parseConfigFile()) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function loadConfig(): Config {
  if (!configExists()) {
    return getDefaultConfig()
  }

  try {
    return parseConfigFile()
  } catch (err) {
    console.error('Failed to load config, using defaults:', (err as Error).message)
    return getDefaultConfig()
  }
}

export function loadConfigStrict(): Config {
  if (!configExists()) throw new Error('Backup configuration is not initialized')
  return parseConfigFile()
}

export function writeConfig(config: Config): void {
  ensureConfigDir()
  const json5 = JSON5.stringify(config, null, 2)
  writeFileSync(CONFIG_PATH, json5, 'utf-8')
}

export function getDefaultConfig(): Config {
  return ConfigSchema.parse({
    destination: {
      name: 'icloud',
      path: resolve(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/restore'),
      type: 'icloud',
    },
    plugins: [],
    plaintextSecretAcceptances: [],
  })
}
