import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { diffWithLastSnapshot } from '../engine/diff.js'
import { pruneSnapshots } from '../engine/prune.js'
import { createSnapshot, ensureBackupRoot, getLatestSnapshotDir } from '../engine/snapshot.js'
import { getEnabledPlugins } from '../plugin/loader.js'
import { color } from '../util/color.js'
import { error } from '../util/log.js'

const BACKUP_DIR_NAME = 'RestoreBackup'

function resolveDestPath(path: string): string {
  return path.startsWith('~/') ? resolve(process.env.HOME || '/tmp', path.slice(2)) : resolve(path)
}

function expandPath(p: string): string {
  return p.startsWith('~/') ? resolve(process.env.HOME || '/tmp', p.slice(2)) : resolve(p)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export function registerBackupCommand(program: Command): void {
  program
    .command('backup')
    .description('Run backup to the configured destination')
    .option('--dry-run', 'Show what would be backed up without copying')
    .action(async (options) => {
      const config = loadConfig()
      const plugins = getEnabledPlugins(config.plugins)

      // Group source paths by plugin
      const pluginSources: { name: string; description: string; paths: string[] }[] = []
      const allSources: string[] = []

      for (const plugin of plugins) {
        const expanded = plugin.paths.map(expandPath)
        pluginSources.push({ name: plugin.name, description: plugin.description, paths: expanded })
        allSources.push(...expanded)
      }

      if (allSources.length === 0) {
        error('No sources to back up. Add plugins with `restore plugin add`.')
        process.exit(1)
      }

      const destRoot = resolveDestPath(config.destination.path)
      const backupRoot = resolve(destRoot, BACKUP_DIR_NAME)

      const latestSnapshot = await getLatestSnapshotDir(backupRoot)

      // Per-plugin summary
      console.log(
        `\n  ${color.bold('Backing up to')} ${color.cyan(config.destination.name)} ${color.dim(`(${backupRoot})`)}\n`,
      )

      if (options.dryRun) {
        for (const pg of pluginSources) {
          const existResults = await Promise.all(pg.paths.map(fileExists))
          const fileCount = existResults.filter(Boolean).length
          console.log(
            `  ${color.bold(pg.name)} ${color.dim(`(${pg.description})`)} — ${fileCount} file(s)`,
          )
          for (let i = 0; i < pg.paths.length; i++) {
            const icon = existResults[i] ? color.icon.ok : color.icon.missing
            console.log(
              `    ${icon} ${existResults[i] ? color.dim(pg.paths[i]) : color.red(pg.paths[i])}`,
            )
          }
        }
        console.log(`\n  ${color.dim(`[dry-run] Would create snapshot at ${backupRoot}`)}\n`)
        return
      }

      // Show per-plugin diff status
      for (const pg of pluginSources) {
        const diffs = await diffWithLastSnapshot(pg.paths, latestSnapshot)
        const fileList: string[] = []
        const validDiffs: typeof diffs = []
        for (const d of diffs) {
          if (d.type === 'added' && !(await fileExists(d.path))) continue
          validDiffs.push(d)
        }

        for (const d of validDiffs) {
          let line: string
          if (d.type === 'unchanged') {
            line = `    ${color.icon.ok} ${color.dim(d.path)}`
          } else if (d.type === 'modified') {
            line = `    ${color.icon.modified} ${color.yellow(d.path)}`
          } else {
            line = `    ${color.icon.added} ${d.path}`
          }
          fileList.push(line)
        }

        const unchanged = validDiffs.filter((d) => d.type === 'unchanged').length
        const modified = validDiffs.filter((d) => d.type === 'modified').length
        const added = validDiffs.filter((d) => d.type === 'added').length

        let summary = `  ${color.bold(pg.name)}`
        const parts: string[] = []
        if (unchanged > 0) parts.push(`${color.green(String(unchanged))} unchanged`)
        if (modified > 0) parts.push(`${color.yellow(String(modified))} updated`)
        if (added > 0) parts.push(`${color.green(String(added))} new`)
        summary += ` — ${parts.join(', ')}`

        console.log(summary)
        for (const line of fileList) {
          if (line.includes('✏')) console.log(line) // only show modified/new
        }
      }

      // Do the backup
      await ensureBackupRoot(backupRoot)
      const snapshotName = await createSnapshot(allSources, backupRoot)
      await pruneSnapshots(backupRoot, config.maxSnapshots)

      console.log(`\n  ${color.bold('✓ Backup complete')} ${color.dim(snapshotName)}\n`)
    })
}
