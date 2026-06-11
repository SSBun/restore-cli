import { resolve } from 'node:path'
import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { pruneSnapshots } from '../engine/prune.js'
import { createSnapshot, ensureBackupRoot } from '../engine/snapshot.js'
import { getEnabledPlugins } from '../plugin/loader.js'
import { error, info } from '../util/log.js'

const BACKUP_DIR_NAME = 'RestoreBackup'

function resolveDestPath(path: string): string {
  return path.startsWith('~/')
    ? resolve(process.env.HOME || '/tmp', path.slice(2))
    : resolve(path)
}

export function registerBackupCommand(program: Command): void {
  program
    .command('backup')
    .description('Run backup to the configured destination')
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

      const destRoot = resolveDestPath(config.destination.path)
      const backupRoot = resolve(destRoot, BACKUP_DIR_NAME)

      info(`Backing up to ${config.destination.name} (${backupRoot})`)

      if (options.dryRun) {
        info(`[dry-run] Would create snapshot at ${backupRoot}`)
        for (const src of sources) {
          info(`  - ${src}`)
        }
        return
      }

      await ensureBackupRoot(backupRoot)
      const snapshotName = await createSnapshot(sources, backupRoot)
      await pruneSnapshots(backupRoot, config.maxSnapshots)
      info(`Backup complete: ${config.destination.name}/${snapshotName}`)
    })
}
