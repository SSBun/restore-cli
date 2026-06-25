import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { isDaemonRunning } from '../daemon/lifecycle.js'
import { getBackupStat } from '../engine/stat.js'
import { info } from '../util/log.js'
import { getBackupRoot } from '../util/path.js'

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  const digits = unitIndex === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

function formatDate(date: Date | null): string {
  return date ? date.toISOString() : 'never'
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current backup status')
    .action(async () => {
      const config = loadConfig()
      const backupRoot = getBackupRoot(config.destination.path)
      const stat = await getBackupStat(backupRoot)
      const daemonState =
        config.daemon.intervalHours === 0 ? 'disabled' : isDaemonRunning() ? 'running' : 'stopped'

      info(`Destination: ${config.destination.name}`)
      info(`Backup root: ${stat.backupRoot}`)
      info(`Daemon: ${daemonState}`)
      info(`Snapshots: ${stat.snapshotCount}`)
      info(`Last backup: ${formatDate(stat.lastBackupAt)}`)
      if (stat.lastBackupName) info(`Last snapshot: ${stat.lastBackupName}`)
      info(`Latest snapshot size: ${formatBytes(stat.latestSnapshotBytes)}`)
      info(`Latest snapshot files: ${stat.latestSnapshotFiles}`)
      info(`Total backup size: ${formatBytes(stat.totalBackupBytes)}`)
      info(`Total backup files: ${stat.totalBackupFiles}`)
    })
}
