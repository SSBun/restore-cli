import { execSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as p from '@clack/prompts'
import { isCancel } from '@clack/prompts'
import { buildCapturePlan } from '../catalog/scope.js'
import { getAllPlugins } from '../plugin/loader.js'
import type { ResolvedPluginManifest } from '../plugin/types.js'
import { getBackupRoot } from '../util/path.js'
import { loadConfig, writeConfig } from './loader.js'
import type { Config, Destination } from './types.js'

function availablePlugins(): ResolvedPluginManifest[] {
  return getAllPlugins().filter((plugin) =>
    plugin.sources.every((source) => source.sensitivity !== 'secret'),
  )
}

function browseFolder(): string | null {
  try {
    return execSync(
      'osascript -e \'POSIX path of (choose folder with prompt "Select sync destination")\'',
      {
        encoding: 'utf8',
        timeout: 30_000,
      },
    ).trim()
  } catch {
    return null
  }
}

function defaultPath(type: Destination['type']): string {
  if (type === 'icloud') return `${homedir()}/Library/Mobile Documents/com~apple~CloudDocs`
  if (type === 'smb') return '/Volumes/backup'
  return `${homedir()}/Desktop/backup`
}

async function askDestination(initial: Destination): Promise<Destination | null> {
  const type = await p.select<
    { value: Destination['type']; label: string; hint?: string }[],
    Destination['type']
  >({
    message: 'What type of sync destination?',
    initialValue: initial.type,
    options: [
      { value: 'icloud', label: 'iCloud Drive', hint: 'Readable files synced by iCloud' },
      { value: 'local', label: 'Local folder' },
      { value: 'smb', label: 'Network / SMB' },
    ],
  })
  if (isCancel(type)) return null

  const name = await p.text({
    message: 'Name this destination',
    initialValue: initial.name,
    validate: (value) => (value.length === 0 ? 'Name is required' : undefined),
  })
  if (isCancel(name)) return null

  const method = await p.select<{ value: 'type' | 'browse'; label: string }[], 'type' | 'browse'>({
    message: 'How to set the folder path?',
    options: [
      { value: 'type', label: 'Type path manually' },
      { value: 'browse', label: 'Browse folder…' },
    ],
  })
  if (isCancel(method)) return null

  let path: string
  if (method === 'browse') {
    const spinner = p.spinner()
    spinner.start('Opening folder picker…')
    const selected = browseFolder()
    spinner.stop(selected ? 'Folder selected' : 'Picker cancelled')
    if (!selected) return null
    path = selected
  } else {
    const value = await p.text({
      message: 'Enter sync destination path',
      initialValue: initial.path || defaultPath(type),
      validate: (input) => (input.length === 0 ? 'Path is required' : undefined),
    })
    if (isCancel(value)) return null
    path = value
  }
  return { name, path, type }
}

async function askPlugins(destinationPath: string, initial: string[]): Promise<string[] | null> {
  const available = availablePlugins()
  const byName = new Map(available.map((plugin) => [plugin.name, plugin]))
  let initialValues = initial.filter((name) => byName.has(name))
  while (true) {
    const result = await p.multiselect<{ value: string; label: string; hint?: string }[], string>({
      message: 'Select files to synchronize:',
      options: available.map((plugin) => ({
        value: plugin.name,
        label: plugin.name,
        hint: plugin.description,
      })),
      required: false,
      initialValues,
    })
    if (isCancel(result)) return null
    const selected = result as string[]
    try {
      buildCapturePlan(
        selected.map((name) => byName.get(name) as ResolvedPluginManifest),
        { forbiddenPaths: [getBackupRoot(destinationPath)] },
      )
      return selected
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error))
      initialValues = selected
    }
  }
}

export async function runWizard(): Promise<void> {
  p.intro('restore setup')
  const initial: Config = loadConfig()
  const destination = await askDestination(initial.destination)
  if (!destination) {
    p.cancel('Setup cancelled')
    return
  }
  const plugins = await askPlugins(destination.path, initial.plugins)
  if (!plugins) {
    p.cancel('Setup cancelled')
    return
  }
  await mkdir(destination.path, { recursive: true, mode: 0o700 })
  writeConfig({ destination, plugins })
  p.log.warn('The synchronized mirror is readable and not encrypted.')
  p.outro('Configuration saved. Run `restore-cli backup --dry-run` to review changes.')
}
