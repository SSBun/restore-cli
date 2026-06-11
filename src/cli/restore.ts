import { resolve } from 'node:path'
import * as p from '@clack/prompts'
import { isCancel } from '@clack/prompts'
import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { getSnapshotInfo, restoreFromSnapshot } from '../engine/restore.js'
import { getEnabledPlugins } from '../plugin/loader.js'
import { error, info } from '../util/log.js'

export function registerRestoreCommand(program: Command): void {
  program
    .command('restore')
    .description('Restore files from a backup snapshot')
    .option('--profile <name>', 'Restore from a specific profile')
    .option('--snapshot <name>', 'Snapshot name to restore from')
    .option('--list', 'List available snapshots')
    .action(async (options) => {
      const config = loadConfig()

      // Narrow to requested profile if --profile was given
      let profiles = config.profiles
      if (options.profile) {
        profiles = profiles.filter((p: { name: string }) => p.name === options.profile)
        if (profiles.length === 0) {
          error(`Profile "${options.profile}" not found`)
          process.exit(1)
        }
      }

      for (const profile of profiles) {
        const profilePath = profile.path.startsWith('~/')
          ? resolve(process.env.HOME || '/tmp', profile.path.slice(2))
          : resolve(profile.path)

        const snapshots = await getSnapshotInfo(profilePath)

        if (options.list) {
          info(`Snapshots for ${profile.name}:`)
          for (const snap of snapshots) {
            info(`  ${snap.name}  (${snap.fileCount} files, ${snap.createdAt.toISOString()})`)
          }
          continue
        }

        if (snapshots.length === 0) {
          error(`No snapshots found for profile "${profile.name}"`)
          continue
        }

        // Let user pick a snapshot (or use --snapshot)
        let snapshotName = options.snapshot
        if (!snapshotName) {
          const result = await p.select({
            message: `Select snapshot to restore from (${profile.name}):`,
            options: snapshots.map((s) => ({
              value: s.name,
              label: `${s.name}  (${s.fileCount} files)`,
            })),
          })
          if (isCancel(result)) {
            p.cancel('Restore cancelled')
            process.exit(0)
          }
          snapshotName = result
        }

        const snapshot = snapshots.find((s) => s.name === snapshotName)
        if (!snapshot) {
          error(`Snapshot "${snapshotName}" not found`)
          process.exit(1)
        }

        // Confirm before overwriting
        const confirm = await p.confirm({
          message: `Restore ${snapshot.fileCount} files from ${snapshotName}? This will OVERWRITE current files.`,
          initialValue: false,
        })
        if (isCancel(confirm) || !confirm) {
          p.cancel('Restore cancelled')
          process.exit(0)
        }

        const plugins = getEnabledPlugins(config.plugins)
        const restoreRoots = plugins.flatMap((p) => p.paths)

        const { restored } = await restoreFromSnapshot(snapshot.path, restoreRoots)
        info(`Restored ${restored} files from ${snapshotName}`)
      }
    })
}
