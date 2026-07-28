import { execSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import * as p from '@clack/prompts'
import { isCancel } from '@clack/prompts'
import { buildCapturePlan } from '../catalog/scope.js'
import { getAllPlugins } from '../plugin/loader.js'
import type { ResolvedPluginManifest } from '../plugin/types.js'
import { initializeRepository } from '../repository/index.js'
import { getBackupRoot } from '../util/path.js'
import { configExists, loadConfig, prunePlaintextSecretAcceptances, writeConfig } from './loader.js'
import type { Config, Destination, RepositoryConfig } from './types.js'

interface PlaintextDestinationDependencies {
  mkdir: typeof mkdir
  initialize: typeof initializeRepository
}

const DEFAULT_PLAINTEXT_DESTINATION_DEPENDENCIES: PlaintextDestinationDependencies = {
  mkdir,
  initialize: initializeRepository,
}

export async function initializePlaintextDestination(
  path: string,
  dependencies: PlaintextDestinationDependencies = DEFAULT_PLAINTEXT_DESTINATION_DEPENDENCIES,
): Promise<RepositoryConfig> {
  await dependencies.mkdir(path, { recursive: true, mode: 0o700 })
  const repository = await dependencies.initialize({ targetPath: path, protection: 'plaintext' })
  return { id: repository.repositoryId, protection: 'plaintext' }
}

async function configurePlaintextDestination(path: string): Promise<RepositoryConfig | null> {
  p.log.warn('Backups in this destination are not encrypted.')
  try {
    return await initializePlaintextDestination(path)
  } catch {
    p.log.error('The backup repository could not be initialized. Configuration was not saved.')
    return null
  }
}

function getAvailablePlugins(
  allowedSecretPlugins: ReadonlySet<string> | null,
): ResolvedPluginManifest[] {
  return getAllPlugins().filter(
    (plugin) =>
      allowedSecretPlugins === null ||
      plugin.sources.every((source) => source.sensitivity !== 'secret') ||
      allowedSecretPlugins.has(plugin.name),
  )
}

function browseFolder(promptMsg?: string): string | null {
  try {
    const script = promptMsg
      ? `POSIX path of (choose folder with prompt "${promptMsg}")`
      : 'POSIX path of (choose folder)'
    const result = execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 30000 })
    return result.trim().replace(/\n$/, '')
  } catch {
    return null
  }
}

function getDefaultPath(type: string): string {
  switch (type) {
    case 'icloud':
      return `${homedir()}/Library/Mobile Documents/com~apple~CloudDocs/restore`
    case 'local':
      return `${homedir()}/Desktop/backup`
    case 'smb':
      return '/Volumes/backup'
    default:
      return `${homedir()}/restore-backup`
  }
}

async function askDestination(initial?: Destination): Promise<Destination | null> {
  const backupType = await p.select<{ value: string; label: string; hint?: string }[], string>({
    message: 'What type of backup destination?',
    initialValue: initial?.type,
    options: [
      { value: 'icloud', label: 'iCloud Drive', hint: 'Files sync across Apple devices' },
      { value: 'local', label: 'Local folder', hint: 'External drive or internal disk' },
      { value: 'smb', label: 'Network / SMB', hint: 'NAS or shared network drive' },
    ],
  })
  if (isCancel(backupType)) return null

  const name = await p.text({
    message: 'Name this backup destination',
    placeholder: 'e.g. icloud, nas, external-ssd',
    initialValue: initial?.name,
    validate: (v) => (v.length === 0 ? 'Name is required' : undefined),
  })
  if (isCancel(name)) return null

  const pathMethod = await p.select<{ value: string; label: string; hint?: string }[], string>({
    message: 'How to set the folder path?',
    options: [
      { value: 'type', label: 'Type path manually' },
      { value: 'browse', label: 'Browse folder…', hint: 'Open system folder picker' },
    ],
  })
  if (isCancel(pathMethod)) return null

  let path: string
  if (pathMethod === 'browse') {
    const s = p.spinner()
    s.start('Opening folder picker…')
    const selected = browseFolder('Select backup destination')
    s.stop(selected ? 'Folder selected' : 'Picker cancelled')
    if (!selected) return null
    path = selected
  } else {
    const typed = await p.text({
      message: 'Enter backup destination path',
      placeholder: getDefaultPath(backupType),
      initialValue: initial?.path,
      validate: (v) => (v.length === 0 ? 'Path is required' : undefined),
    })
    if (isCancel(typed)) return null
    path = typed
  }

  return { name, path, type: backupType as Destination['type'] }
}

async function askBackupSettings(initial?: { interval: number; maxSnapshots: number }) {
  const daemonInterval = await p.text({
    message: 'Auto-backup interval in hours (0 disables the background daemon)',
    placeholder: '12',
    initialValue: initial ? String(initial.interval) : undefined,
    validate: (v) => {
      if (v && (Number.isNaN(Number(v)) || Number(v) < 0)) return 'Must be a non-negative number'
    },
  })
  if (isCancel(daemonInterval)) return null

  const maxSnapshotsInput = await p.text({
    message: 'Maximum snapshots to keep',
    placeholder: '14',
    initialValue: initial ? String(initial.maxSnapshots) : undefined,
    validate: (v) => {
      if (v && (Number.isNaN(Number(v)) || Number(v) <= 0)) return 'Must be a positive number'
    },
  })
  if (isCancel(maxSnapshotsInput)) return null

  return {
    interval: daemonInterval && !isCancel(daemonInterval) ? Number(daemonInterval) : 12,
    maxSnapshots:
      maxSnapshotsInput && !isCancel(maxSnapshotsInput) ? Number(maxSnapshotsInput) : 14,
  }
}

async function askPlugins(
  destinationPath: string,
  initial?: string[],
  allowedSecretPlugins: ReadonlySet<string> | null = new Set(),
): Promise<string[] | null> {
  const available = getAvailablePlugins(allowedSecretPlugins)
  if (available.length === 0) return []
  const byName = new Map(available.map((plugin) => [plugin.name, plugin]))
  let initialValues = initial?.filter((name) => byName.has(name))

  if (allowedSecretPlugins?.size === 0) {
    p.log.warn('Plugins containing secrets are unavailable with the default plaintext repository.')
  }

  while (true) {
    const result = await p.multiselect<{ value: string; label: string; hint?: string }[], string>({
      message: 'Select plugins (what to back up):',
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
        selected.flatMap((name) => {
          const plugin = byName.get(name)
          return plugin ? [plugin] : []
        }),
        { forbiddenPaths: [getBackupRoot(destinationPath)] },
      )
      return selected
    } catch (error) {
      p.log.error(
        `Invalid plugin selection: ${error instanceof Error ? error.message : String(error)}`,
      )
      initialValues = selected
    }
  }
}

function retainedSecretPlugins(config: Config): ReadonlySet<string> | null {
  if (config.repository?.protection === 'encrypted') return null
  return new Set(config.repository ? config.plugins : [])
}

function removeSecretPlugins(plugins: string[]): string[] {
  const available = new Set(getAvailablePlugins(new Set()).map((plugin) => plugin.name))
  return plugins.filter((plugin) => available.has(plugin))
}

function saveConfig(
  destination: Destination,
  settings: { interval: number; maxSnapshots: number },
  plugins: string[],
  retained: Pick<Config, 'repository' | 'plaintextSecretAcceptances'> = {},
): void {
  const nextConfig: Config = {
    destination,
    ...(retained.repository ? { repository: retained.repository } : {}),
    plugins,
    plaintextSecretAcceptances: retained.plaintextSecretAcceptances ?? [],
    daemon: { intervalHours: settings.interval },
    maxSnapshots: settings.maxSnapshots,
  }
  writeConfig(prunePlaintextSecretAcceptances(nextConfig))
}

export async function runWizard(): Promise<void> {
  p.intro('restore setup')

  if (!configExists()) {
    const destination = await askDestination()
    if (!destination) {
      p.cancel('Setup cancelled')
      return
    }

    const settings = await askBackupSettings()
    if (!settings) {
      p.cancel('Setup cancelled')
      return
    }

    const plugins = await askPlugins(destination.path)
    if (!plugins) {
      p.cancel('Setup cancelled')
      return
    }

    const repository = await configurePlaintextDestination(destination.path)
    if (!repository) return
    saveConfig(destination, settings, plugins, { repository })
    p.outro('Setup complete! Run `restore-cli backup` to start backing up.')
    return
  }

  // Management menu — loops until user saves or cancels
  const config = loadConfig()
  let destination = { ...config.destination }
  let settings = { interval: config.daemon.intervalHours, maxSnapshots: config.maxSnapshots }
  let plugins = [...config.plugins]
  let dirty = false

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const action = await p.select<{ value: string; label: string; hint?: string }[], string>({
      message: 'Backup configuration:',
      options: [
        {
          value: 'edit-destination',
          label: 'Edit destination',
          hint: `${destination.name} (${destination.path})`,
        },
        {
          value: 'edit-settings',
          label: 'Change backup settings',
          hint: `${settings.interval === 0 ? 'daemon disabled' : `interval ${settings.interval}h`}, ${settings.maxSnapshots} snapshots`,
        },
        {
          value: 'edit-plugins',
          label: 'Change plugins',
          hint: `${plugins.length} plugin(s) selected`,
        },
        { value: 'full-reset', label: 'Full re-setup', hint: 'Overwrite all settings' },
        { value: 'save-exit', label: dirty ? 'Save & exit' : 'Exit' },
      ],
    })
    if (isCancel(action)) {
      p.cancel('Cancelled')
      return
    }

    if (action === 'save-exit') {
      if (dirty) {
        const destinationChanged = resolve(destination.path) !== resolve(config.destination.path)
        const createsPlaintextRepository = destinationChanged || !config.repository
        const repository = createsPlaintextRepository
          ? await configurePlaintextDestination(destination.path)
          : config.repository
        if (!repository) return
        const savedPlugins = createsPlaintextRepository ? removeSecretPlugins(plugins) : plugins
        if (savedPlugins.length !== plugins.length) {
          p.log.warn('Plugins containing secrets were removed from the new plaintext repository.')
        }
        saveConfig(destination, settings, savedPlugins, { ...config, repository })
        p.outro('Configuration updated!')
      }
      return
    }

    let changed = false
    if (action === 'edit-destination') {
      const d = await askDestination(destination)
      if (d) {
        destination = d
        changed = true
      }
    } else if (action === 'edit-settings') {
      const s = await askBackupSettings(settings)
      if (s) {
        settings = s
        changed = true
      }
    } else if (action === 'edit-plugins') {
      const retainsRepository = resolve(destination.path) === resolve(config.destination.path)
      const allowedSecrets = retainsRepository ? retainedSecretPlugins(config) : new Set<string>()
      const pResult = await askPlugins(destination.path, plugins, allowedSecrets)
      if (pResult !== null) {
        plugins = pResult
        changed = true
      }
    } else if (action === 'full-reset') {
      const d = await askDestination()
      if (!d) continue
      const s = await askBackupSettings()
      if (!s) continue
      const retainsRepository = resolve(d.path) === resolve(config.destination.path)
      const allowedSecrets = retainsRepository ? retainedSecretPlugins(config) : new Set<string>()
      const pResult = await askPlugins(d.path, undefined, allowedSecrets)
      if (pResult === null) continue
      destination = d
      settings = s
      plugins = pResult
      changed = true
    }

    if (changed) dirty = true
  }
}
