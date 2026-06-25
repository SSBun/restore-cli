import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import JSON5 from 'json5'
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

export function validateConfigFile(): ConfigValidationResult {
  ensureConfigDir()

  if (!configExists()) {
    return { ok: false, error: `Config file not found: ${CONFIG_PATH}` }
  }

  try {
    return { ok: true, config: parseConfigFile() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function loadConfig(): Config {
  ensureConfigDir()

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
  })
}
