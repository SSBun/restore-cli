import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import * as p from '@clack/prompts'
import { isCancel } from '@clack/prompts'
import { addPlugin, getBuiltinPlugins, getPluginNames } from '../plugin/registry.js'
import { configExists, loadConfig, writeConfig } from './loader.js'
import type { Config } from './types.js'
import type { Destination } from './types.js'

interface PluginInfo {
  name: string
  description?: string
}

function getAvailablePlugins(): PluginInfo[] {
  try {
    const names = getPluginNames()
    const builtins = getBuiltinPlugins()
    return names.map((name) => ({
      name,
      description: builtins.find((b) => b.name === name)?.description,
    }))
  } catch {
    return []
  }
}

function browseFolder(promptMsg?: string): string | null {
  try {
    const script = promptMsg
      ? `POSIX path of (choose folder with prompt "${promptMsg}")`
      : 'POSIX path of (choose folder)'
    const result = execSync(`osascript -e '${script}'`, {
      encoding: 'utf-8',
      timeout: 30000,
    })
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

async function askDestination(initial?: Destination): Promise<Destination> {
  // Type
  const backupType = await p.select<{ value: string; label: string; hint?: string }[], string>({
    message: 'What type of backup destination?',
    initialValue: initial?.type,
    options: [
      { value: 'icloud', label: 'iCloud Drive', hint: 'Files sync across Apple devices' },
      { value: 'local', label: 'Local folder', hint: 'External drive or internal disk' },
      { value: 'smb', label: 'Network / SMB', hint: 'NAS or shared network drive' },
    ],
  })
  if (isCancel(backupType)) process.exit(0)

  // Name
  const name = await p.text({
    message: 'Name this backup destination',
    placeholder: 'e.g. icloud, nas, external-ssd',
    initialValue: initial?.name,
    validate: (v) => (v.length === 0 ? 'Name is required' : undefined),
  })
  if (isCancel(name)) process.exit(0)

  // Path input method
  const pathMethod = await p.select<{ value: string; label: string; hint?: string }[], string>({
    message: 'How to set the folder path?',
    options: [
      { value: 'type', label: 'Type path manually' },
      { value: 'browse', label: 'Browse folder…', hint: 'Open system folder picker' },
    ],
  })
  if (isCancel(pathMethod)) process.exit(0)

  // Path
  let path: string
  if (pathMethod === 'browse') {
    const s = p.spinner()
    s.start('Opening folder picker…')
    const selected = browseFolder('Select backup destination')
    s.stop(selected ? 'Folder selected' : 'Picker cancelled')
    if (!selected) {
      p.cancel('No folder selected')
      process.exit(0)
    }
    path = selected
  } else {
    const typed = await p.text({
      message: 'Enter backup destination path',
      placeholder: getDefaultPath(backupType),
      initialValue: initial?.path,
      validate: (v) => (v.length === 0 ? 'Path is required' : undefined),
    })
    if (isCancel(typed)) process.exit(0)
    path = typed
  }

  return { name, path, type: backupType as Destination['type'] }
}

async function askBackupSettings(initial?: { interval: number; maxSnapshots: number }) {
  const daemonInterval = await p.text({
    message: 'Auto-backup interval in hours (0 to disable daemon)',
    placeholder: '12',
    initialValue: initial ? String(initial.interval) : undefined,
    validate: (v) => {
      if (v && (Number.isNaN(Number(v)) || Number(v) < 0)) return 'Must be a non-negative number'
    },
  })

  const maxSnapshotsInput = await p.text({
    message: 'Maximum snapshots to keep',
    placeholder: '14',
    initialValue: initial ? String(initial.maxSnapshots) : undefined,
    validate: (v) => {
      if (v && (Number.isNaN(Number(v)) || Number(v) <= 0)) return 'Must be a positive number'
    },
  })

  return {
    interval: daemonInterval && !isCancel(daemonInterval) ? Number(daemonInterval) : 12,
    maxSnapshots:
      maxSnapshotsInput && !isCancel(maxSnapshotsInput) ? Number(maxSnapshotsInput) : 14,
  }
}

async function askPlugins(initial?: string[]): Promise<string[]> {
  const available = getAvailablePlugins()
  if (available.length === 0) return []

  const result = await p.multiselect<{ value: string; label: string; hint?: string }[], string>({
    message: 'Select plugins (what to back up):',
    options: available.map((pl) => ({
      value: pl.name,
      label: pl.name,
      hint: pl.description,
    })),
    required: false,
    initialValues: initial,
  })

  if (isCancel(result)) process.exit(0)
  const selected = result as string[]

  for (const name of selected) addPlugin(name)
  return selected
}

export async function runWizard(): Promise<void> {
  p.intro('restore setup')

  if (!configExists()) {
    // First-time setup — full creation flow
    const destination = await askDestination()
    const settings = await askBackupSettings()
    const plugins = await askPlugins()

    writeConfig({
      destination,
      plugins,
      daemon: { intervalHours: settings.interval },
      maxSnapshots: settings.maxSnapshots,
    })

    p.outro('Setup complete! Run `restore-cli backup` to start backing up.')
    return
  }

  // Config exists — show management menu
  const config = loadConfig()

  const action = await p.select<{ value: string; label: string; hint?: string }[], string>({
    message: 'Backup configuration:',
    options: [
      {
        value: 'edit-destination',
        label: 'Edit destination',
        hint: `${config.destination.name} (${config.destination.path})`,
      },
      {
        value: 'edit-settings',
        label: 'Change backup settings',
        hint: `interval ${config.daemon.intervalHours}h, ${config.maxSnapshots} snapshots`,
      },
      {
        value: 'edit-plugins',
        label: 'Change plugins',
        hint: `${config.plugins.length} plugin(s) selected`,
      },
      { value: 'full-reset', label: 'Full re-setup', hint: 'Overwrite all settings' },
    ],
  })
  if (isCancel(action)) {
    p.cancel('Cancelled')
    process.exit(0)
  }

  let destination = config.destination
  let settings = { interval: config.daemon.intervalHours, maxSnapshots: config.maxSnapshots }
  let plugins = config.plugins

  switch (action) {
    case 'edit-destination':
      destination = await askDestination(config.destination)
      break
    case 'edit-settings':
      settings = await askBackupSettings(settings)
      break
    case 'edit-plugins':
      plugins = await askPlugins(config.plugins)
      break
    case 'full-reset':
      destination = await askDestination()
      settings = await askBackupSettings()
      plugins = await askPlugins()
      break
  }

  writeConfig({
    destination,
    plugins,
    daemon: { intervalHours: settings.interval },
    maxSnapshots: settings.maxSnapshots,
  })

  p.outro('Configuration updated!')
}
