import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import * as p from '@clack/prompts'
import { isCancel } from '@clack/prompts'
import { addPlugin, getBuiltinPlugins, getPluginNames } from '../plugin/registry.js'
import { configExists, loadConfig, writeConfig } from './loader.js'
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
    message: 'Auto-backup interval in hours (0 to disable daemon)',
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

async function askPlugins(initial?: string[]): Promise<string[] | null> {
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
  if (isCancel(result)) return null

  const selected = result as string[]
  for (const name of selected) addPlugin(name)
  return selected
}

function saveConfig(
  destination: Destination,
  settings: { interval: number; maxSnapshots: number },
  plugins: string[],
): void {
  writeConfig({
    destination,
    plugins,
    daemon: { intervalHours: settings.interval },
    maxSnapshots: settings.maxSnapshots,
  })
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

    const plugins = await askPlugins()
    if (!plugins) {
      p.cancel('Setup cancelled')
      return
    }

    saveConfig(destination, settings, plugins)
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
          hint: `interval ${settings.interval}h, ${settings.maxSnapshots} snapshots`,
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
        saveConfig(destination, settings, plugins)
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
      const pResult = await askPlugins(plugins)
      if (pResult !== null) {
        plugins = pResult
        changed = true
      }
    } else if (action === 'full-reset') {
      const d = await askDestination()
      if (!d) continue
      const s = await askBackupSettings()
      if (!s) continue
      const pResult = await askPlugins()
      if (pResult === null) continue
      destination = d
      settings = s
      plugins = pResult
      changed = true
    }

    if (changed) dirty = true
  }
}
