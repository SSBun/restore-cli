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

export async function runWizard(): Promise<void> {
  p.intro('restore setup')

  // Step 1: Add backup profiles
  const profiles: Profile[] = []
  let addMore = true

  while (addMore) {
    const profileGroup = await p.group(
      {
        name: () =>
          p.text({
            message: 'Profile name',
            placeholder: 'e.g. icloud, external',
            validate: (v) => (v.length === 0 ? 'Name is required' : undefined),
          }),
        path: () =>
          p.text({
            message: 'Backup destination path',
            placeholder: 'e.g. ~/Library/Mobile Documents/com~apple~CloudDocs/restore',
            validate: (v) => (v.length === 0 ? 'Path is required' : undefined),
          }),
        type: () =>
          p.select<{ value: string; label: string; hint?: string }[], string>({
            message: 'Destination type',
            options: [
              { value: 'icloud', label: 'iCloud Drive' },
              { value: 'local', label: 'Local folder' },
              { value: 'smb', label: 'Network/SMB' },
            ],
          }),
        interval: () =>
          p.text({
            message: 'Backup interval in hours (optional, for daemon mode)',
            placeholder: '12',
            validate: (v) => {
              if (v && (Number.isNaN(Number(v)) || Number(v) <= 0)) {
                return 'Must be a positive number'
              }
            },
          }),
      },
      {
        onCancel: () => {
          p.cancel('Setup cancelled')
          process.exit(0)
        },
      },
    )

    profiles.push({
      name: profileGroup.name,
      path: profileGroup.path,
      type: profileGroup.type as Profile['type'],
      intervalHours: profileGroup.interval ? Number(profileGroup.interval) : undefined,
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
