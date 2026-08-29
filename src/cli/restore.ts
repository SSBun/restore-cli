import * as p from '@clack/prompts'
import { isCancel } from '@clack/prompts'
import type { Command } from 'commander'
import { loadConfigStrict, resolveBackupConfiguration } from '../config/loader.js'
import { MirrorError, inspectMirror, restoreMirror } from '../mirror/index.js'
import { isQuiet } from '../util/log.js'
import { createProgressIndicator } from '../util/progress.js'
import { emitCliResult } from '../util/result.js'
import { formatMirrorDiff } from './backup-format.js'

const EXIT_CODES = {
  success: 0,
  configuration: 10,
  source: 13,
  destination: 14,
  integrity: 15,
  cancelled: 17,
  internal: 20,
} as const

type RestoreCategory = keyof typeof EXIT_CODES

function result(
  state: 'success' | 'cancelled' | 'failure',
  category: RestoreCategory,
  startedAt: string,
  fields: Record<string, unknown>,
) {
  return {
    operation: 'restore',
    state,
    category,
    startedAt,
    endedAt: new Date().toISOString(),
    ...fields,
  }
}

export function registerRestoreCommand(program: Command): void {
  program
    .command('restore')
    .description('Compare the mirror with original paths and restore confirmed differences')
    .option('--dry-run', 'show differences without changing original paths')
    .option('--execute', 'restore all displayed differences without prompting')
    .action(async (options: { dryRun?: boolean; execute?: boolean }) => {
      const startedAt = new Date().toISOString()
      let output: Record<string, unknown>
      let category: RestoreCategory = 'success'
      const progress = createProgressIndicator()
      try {
        if (options.dryRun && options.execute) {
          throw new MirrorError(
            'CONFLICTING_FLAGS',
            'configuration',
            '--dry-run and --execute cannot be combined',
          )
        }
        const resolved = resolveBackupConfiguration(loadConfigStrict())
        progress.start('Comparing mirror with original paths')
        const inspected = await inspectMirror(resolved.mirrorPath, resolved.plan)
        progress.stop()
        if (!isQuiet()) {
          for (const line of formatMirrorDiff(inspected.diff, 'Restore diff')) console.error(line)
        }
        if (inspected.diff.length === 0) {
          output = result('success', 'success', startedAt, {
            dryRun: options.dryRun === true,
            executed: false,
            counts: { created: 0, modified: 0, deleted: 0 },
            issues: [],
            nextAction: null,
          })
        } else {
          let execute = options.execute === true
          const global = program.opts()
          if (!options.dryRun && !execute) {
            if (
              global.json ||
              global.nonInteractive ||
              !process.stdin.isTTY ||
              !process.stdout.isTTY
            ) {
              throw new MirrorError(
                'RESTORE_CONFIRMATION_REQUIRED',
                'configuration',
                'Non-interactive restore requires --execute after reviewing --dry-run',
              )
            }
            const confirmed = await p.confirm({
              message: `Restore all ${inspected.diff.length} differences to their original paths?`,
              initialValue: false,
            })
            if (isCancel(confirmed) || confirmed !== true) {
              category = 'cancelled'
              output = result('cancelled', category, startedAt, {
                dryRun: false,
                executed: false,
                counts: { created: 0, modified: 0, deleted: 0 },
                issues: [],
                nextAction: 'No original path was changed',
              })
              emitCliResult(program, (value) => console.log(value), output)
              process.exitCode = EXIT_CODES[category]
              return
            }
            execute = true
          }

          if (execute) {
            progress.start('Restoring confirmed differences')
            await restoreMirror(resolved.mirrorPath, resolved.plan, (message) =>
              progress.update(message),
            )
            progress.stop()
          }
          const counts = {
            created: inspected.diff.filter((entry) => entry.action === 'create').length,
            modified: inspected.diff.filter((entry) => entry.action === 'modify').length,
            deleted: inspected.diff.filter((entry) => entry.action === 'delete').length,
          }
          output = result('success', 'success', startedAt, {
            dryRun: options.dryRun === true,
            executed: execute,
            counts,
            issues: [],
            nextAction: options.dryRun ? 'Run restore and confirm the displayed diff' : null,
          })
        }
      } catch (error) {
        progress.stop()
        const known = error instanceof MirrorError ? error : undefined
        category = (known?.category ?? 'internal') as RestoreCategory
        output = result('failure', category, startedAt, {
          dryRun: options.dryRun === true,
          executed: false,
          issues: [
            {
              code: known?.code ?? 'RESTORE_FAILED',
              category,
              message: known?.message ?? 'Restore failed',
            },
          ],
          nextAction: 'Resolve the reported issue and retry restore --dry-run',
        })
        console.error(`restore: ${(output.issues as Array<{ code: string }>)[0]?.code}`)
      }
      emitCliResult(program, (value) => console.log(value), output)
      process.exitCode = EXIT_CODES[category]
    })
}
