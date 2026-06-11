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

export function loadConfig(): Config {
  ensureConfigDir()

  if (!configExists()) {
    return getDefaultConfig()
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = JSON5.parse(raw)
    return ConfigSchema.parse(parsed)
  } catch (err) {
    console.error('Failed to load config, using defaults:', (err as Error).message)
    return getDefaultConfig()
  }
}

export function writeConfig(config: Config): void {
  ensureConfigDir()
  const json = JSON.stringify(config, null, 2)
  writeFileSync(CONFIG_PATH, json, 'utf-8')
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
