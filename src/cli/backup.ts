import { resolve } from 'node:path'
import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { pruneSnapshots } from '../engine/prune.js'
import { createSnapshot } from '../engine/snapshot.js'
import { getEnabledPlugins } from '../plugin/loader.js'
import { error, info } from '../util/log.js'

export function registerBackupCommand(program: Command): void {
  program
    .command('backup')
    .description('Run backup for all configured profiles')
    .option('--profile <name>', 'Only back up to a specific profile')
    .option('--dry-run', 'Show what would be backed up without copying')
    .action(async (options) => {
      const config = loadConfig()
      const plugins = getEnabledPlugins(config.plugins)

      // Collect source paths from all plugins
      const sources: string[] = []
      for (const plugin of plugins) {
        const expanded = plugin.paths.map((p: string) =>
          p.startsWith('~/') ? resolve(process.env.HOME || '/tmp', p.slice(2)) : resolve(p),
        )
        sources.push(...expanded)
      }

      if (sources.length === 0) {
        error('No sources to back up. Add plugins with `restore plugin add`.')
        process.exit(1)
      }

      // Filter profiles
      let profiles = config.profiles
      if (options.profile) {
        profiles = profiles.filter((p: { name: string }) => p.name === options.profile)
        if (profiles.length === 0) {
          error(`Profile "${options.profile}" not found`)
          process.exit(1)
        }
      }

      for (const profile of profiles) {
        const destDir = resolve(
          profile.path.startsWith('~/')
            ? resolve(process.env.HOME || '/tmp', profile.path.slice(2))
            : profile.path,
        )

        info(`Backing up to ${profile.name} (${destDir})`)

        if (options.dryRun) {
          info(`[dry-run] Would create snapshot at ${destDir}`)
          for (const src of sources) {
            info(`  - ${src}`)
          }
          continue
        }

        const snapshotName = await createSnapshot(sources, destDir)
        await pruneSnapshots(destDir, config.maxSnapshots)
        info(`Backup complete: ${profile.name}/${snapshotName}`)
      }
    })
}
