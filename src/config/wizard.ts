import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import * as p from '@clack/prompts'
import { isCancel } from '@clack/prompts'
import { getBuiltinPlugins, getPluginNames } from '../plugin/registry.js'
import { writeConfig } from './loader.js'
import type { Config, Profile } from './types.js'

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

function browseFolder(): string | null {
  try {
    const result = execSync(
      'osascript -e \'POSIX path of (choose folder with prompt "Select backup destination")\'',
      { encoding: 'utf-8', timeout: 30000 },
    )
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

export async function runWizard(): Promise<void> {
  p.intro('restore setup')

  const profiles: Profile[] = []
  let addMore = true

  while (addMore) {
    // 1a. Choose backup type
    const backupType = await p.select<{ value: string; label: string; hint?: string }[], string>({
      message: 'What type of backup destination?',
      options: [
        { value: 'icloud', label: 'iCloud Drive', hint: 'Files sync across Apple devices' },
        { value: 'local', label: 'Local folder', hint: 'External drive or internal disk' },
        { value: 'smb', label: 'Network / SMB', hint: 'NAS or shared network drive' },
      ],
    })
    if (isCancel(backupType)) {
      p.cancel('Setup cancelled')
      process.exit(0)
    }

    // 1b. Input profile name
    const name = await p.text({
      message: 'Name this backup destination',
      placeholder: 'e.g. icloud, nas, external-ssd',
      validate: (v) => (v.length === 0 ? 'Name is required' : undefined),
    })
    if (isCancel(name)) {
      p.cancel('Setup cancelled')
      process.exit(0)
    }

    // 1c. Choose how to provide the path
    const pathMethod = await p.select<{ value: string; label: string; hint?: string }[], string>({
      message: 'How to set the folder path?',
      options: [
        { value: 'type', label: 'Type path manually' },
        { value: 'browse', label: 'Browse folder…', hint: 'Open system folder picker' },
      ],
    })
    if (isCancel(pathMethod)) {
      p.cancel('Setup cancelled')
      process.exit(0)
    }

    // 1d. Get the folder path
    let path: string
    if (pathMethod === 'browse') {
      const s = p.spinner()
      s.start('Opening folder picker…')
      const selected = browseFolder()
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
        validate: (v) => (v.length === 0 ? 'Path is required' : undefined),
      })
      if (isCancel(typed)) {
        p.cancel('Setup cancelled')
        process.exit(0)
      }
      path = typed
    }

    // 1e. Optional interval
    const interval = await p.text({
      message: 'Backup interval in hours (optional, for daemon mode)',
      placeholder: '12',
      validate: (v) => {
        if (v && (Number.isNaN(Number(v)) || Number(v) <= 0)) {
          return 'Must be a positive number'
        }
      },
    })
    if (isCancel(interval)) {
      p.cancel('Setup cancelled')
      process.exit(0)
    }

    profiles.push({
      name,
      path,
      type: backupType as Profile['type'],
      intervalHours: interval ? Number(interval) : undefined,
    })

    const addMoreResult = await p.confirm({
      message: 'Add another backup destination?',
      initialValue: false,
    })
    if (isCancel(addMoreResult)) {
      p.cancel('Setup cancelled')
      process.exit(0)
    }
    addMore = addMoreResult
  }

  // Step 2: Select plugins
  const availablePlugins = getAvailablePlugins()
  let selectedPlugins: string[] = []

  if (availablePlugins.length > 0) {
    const pluginResult = await p.multiselect<
      { value: string; label: string; hint?: string }[],
      string
    >({
      message: 'Select plugins (what to back up):',
      options: availablePlugins.map((pl) => ({
        value: pl.name,
        label: pl.name,
        hint: pl.description,
      })),
      required: false,
    })
    if (!isCancel(pluginResult)) {
      selectedPlugins = pluginResult as string[]
    }
  }

  // Step 3: Daemon settings
  const daemonInterval = await p.text({
    message: 'Auto-backup interval in hours (0 to disable daemon)',
    placeholder: '12',
    validate: (v) => {
      if (v && (Number.isNaN(Number(v)) || Number(v) < 0)) {
        return 'Must be a non-negative number'
      }
    },
  })

  // Step 4: Max snapshots
  const maxSnapshotsInput = await p.text({
    message: 'Maximum snapshots to keep (advanced)',
    placeholder: '14',
    validate: (v) => {
      if (v && (Number.isNaN(Number(v)) || Number(v) <= 0)) {
        return 'Must be a positive number'
      }
    },
  })

  // Step 5: Write config
  const config: Config = {
    profiles,
    plugins: selectedPlugins,
    daemon: {
      intervalHours: daemonInterval && !isCancel(daemonInterval) ? Number(daemonInterval) : 12,
    },
    maxSnapshots:
      maxSnapshotsInput && !isCancel(maxSnapshotsInput) ? Number(maxSnapshotsInput) : 14,
  }

  writeConfig(config)
  p.outro('Setup complete! Run `restore backup` to start backing up.')
}
