import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { executeBackupPlan, prepareAndPlan } from '../engine/run-backup.js'
import { error, isVerbose } from '../util/log.js'
import { getBackupRoot } from '../util/path.js'
import {
  formatBackupFooter,
  formatBackupHeader,
  formatChangedPlugins,
  formatChangesList,
  formatDryRunFooter,
  formatPlanSummary,
  formatPluginPhaseDone,
  formatPluginPhaseStart,
  formatPluginTable,
  formatSkippedPaths,
  formatSkippedSummary,
  formatStageDone,
  formatSyncFile,
  formatSyncResult,
  formatSyncStart,
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
    .option('--verbose', 'Print detailed backup logs')
    .action(async (options) => {
      const config = loadConfig()
      const backupRoot = getBackupRoot(config.destination.path)
      const verbose = Boolean(options.verbose) || isVerbose()

      try {
        printLines(formatBackupHeader(config.destination.name, backupRoot))

        let printedPrepareHeader = false
        let printedAnalyzeHeader = false
        let preparedInventories = 0
        const plan = await prepareAndPlan(config, {
          skipPrepare: Boolean(options.dryRun),
          progress: {
            onPrepareStart: (pluginName, current, total) => {
              if (verbose && !printedPrepareHeader) {
                console.log('Preparing plugin inventories:')
                printedPrepareHeader = true
              }
              if (verbose) {
                console.log(formatPluginPhaseStart(pluginName, current, total))
              }
            },
            onPrepareDone: (pluginName, current, total) => {
              if (verbose) {
                console.log(formatPluginPhaseDone(pluginName, current, total))
              } else if (current === total) {
                preparedInventories = total
              }
            },
            onAnalyzeStart: (pluginName, current, total) => {
              if (verbose && !printedAnalyzeHeader) {
                if (printedPrepareHeader) console.log('')
                console.log('Analyzing plugins:')
                printedAnalyzeHeader = true
              }
              if (verbose) {
                console.log(formatPluginPhaseStart(pluginName, current, total))
              }
            },
          },
        })

        if (printedAnalyzeHeader) console.log('')

        if (!verbose) {
          console.log(
            formatStageDone(1, 4, 'Preparing inventories', `${preparedInventories} generated`),
          )
          console.log(formatStageDone(2, 4, 'Analyzing plugins', `${plan.rows.length} scanned`))
        }

        if (verbose || options.dryRun) {
          printLines([
            ...formatPluginTable(plan.rows),
            ...formatChangesList(plan.changes),
            ...formatSkippedPaths(plan.skippedPaths),
          ])
        } else {
          printLines(formatPlanSummary(plan.rows, plan.changes, plan.skippedPaths))
        }

        if (options.dryRun) {
          printLines(formatDryRunFooter())
          return
        }

        if (verbose) {
          console.log('')
          console.log('Syncing plugins:')
        }
        const result = await executeBackupPlan(plan, config.maxSnapshots, {
          onSyncStart: (pluginName, _completed, _total, fileTotal) => {
            if (verbose) {
              console.log(formatSyncStart(pluginName, fileTotal))
            }
          },
          onSyncFile: (event) => {
            if (verbose) {
              console.log(formatSyncFile(event))
            }
          },
        })

        if (verbose) {
          printLines(formatSyncResult(result.pluginResults))
        } else {
          console.log(
            formatStageDone(
              3,
              4,
              'Syncing snapshot',
              `${result.linked} linked, ${result.copied} copied`,
            ),
          )
          console.log(formatStageDone(4, 4, 'Pruning snapshots', `${result.pruned} removed`))
          printLines(formatChangedPlugins(plan.rows, result.pluginResults))
          printLines(formatSkippedSummary(plan.skippedPaths.length))
        }
        printLines(
          formatBackupFooter(
            result.snapshotName,
            result.linked,
            result.copied,
            result.pruned,
            result.pruneFailed.length,
          ),
        )
      } catch (err) {
        error((err as Error).message)
        process.exit(1)
      }
    })
}
