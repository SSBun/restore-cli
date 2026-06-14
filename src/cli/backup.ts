import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { executeBackupPlan, prepareAndPlan } from '../engine/run-backup.js'
import { error } from '../util/log.js'
import { getBackupRoot } from '../util/path.js'
import {
  formatBackupFooter,
  formatBackupHeader,
  formatChangesList,
  formatDryRunFooter,
  formatPluginTable,
} from './backup-format.js'

function printLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line)
  }
}

export function registerBackupCommand(program: Command): void {
  program
    .command('backup')
    .description('Run backup to the configured destination')
    .option('--dry-run', 'Show what would be backed up without copying')
    .action(async (options) => {
      const config = loadConfig()
      const backupRoot = getBackupRoot(config.destination.path)

      try {
        printLines(formatBackupHeader(config.destination.name, backupRoot))

        const plan = await prepareAndPlan(config)

        printLines([...formatPluginTable(plan.rows), ...formatChangesList(plan.changes)])

        if (options.dryRun) {
          printLines(formatDryRunFooter())
          return
        }

        const result = await executeBackupPlan(plan, config.maxSnapshots)

        printLines(
          formatBackupFooter(result.snapshotName, result.linked, result.copied, result.pruned),
        )
      } catch (err) {
        error((err as Error).message)
        process.exit(1)
      }
    })
}
