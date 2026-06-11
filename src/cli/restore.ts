import { resolve } from 'node:path'
import * as p from '@clack/prompts'
import { isCancel } from '@clack/prompts'
import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { getSnapshotInfo, restoreFromSnapshot } from '../engine/restore.js'
import { getEnabledPlugins } from '../plugin/loader.js'
import { error, info } from '../util/log.js'

const BACKUP_DIR_NAME = 'RestoreBackup'

function resolveDestPath(path: string): string {
  return path.startsWith('~/')
    ? resolve(process.env.HOME || '/tmp', path.slice(2))
    : resolve(path)
}

export function registerRestoreCommand(program: Command): void {
  program
    .command('restore')
    .description('Restore files from a backup snapshot')
    .option('--snapshot <name>', 'Snapshot name to restore from')
    .option('--list', 'List available snapshots')
    .action(async (options) => {
      const config = loadConfig()
      const backupRoot = resolve(resolveDestPath(config.destination.path), BACKUP_DIR_NAME)
      const snapshots = await getSnapshotInfo(backupRoot)

      if (options.list) {
        info(`Snapshots for ${config.destination.name}:`)
        for (const snap of snapshots) {
          info(`  ${snap.name}  (${snap.fileCount} files, ${snap.createdAt.toISOString()})`)
        }
        return
      }

      if (snapshots.length === 0) {
        error('No snapshots found. Run `restore backup` first.')
        process.exit(1)
      }

      // Let user pick a snapshot (or use --snapshot)
      let snapshotName = options.snapshot
      if (!snapshotName) {
        const result = await p.select({
          message: 'Select snapshot to restore from:',
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
    })
}
