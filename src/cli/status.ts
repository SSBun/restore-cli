import type { Command } from 'commander'
import { loadConfigStrict, resolveBackupConfiguration } from '../config/loader.js'
import { MirrorError, inspectMirror } from '../mirror/index.js'
import { isQuiet } from '../util/log.js'
import { createProgressIndicator } from '../util/progress.js'
import { emitCliResult } from '../util/result.js'
import { formatMirrorDiff } from './backup-format.js'

const EXIT_CODES = {
  success: 0,
  warning: 2,
  configuration: 10,
  source: 13,
  destination: 14,
  integrity: 15,
  internal: 20,
} as const

type StatusCategory = keyof typeof EXIT_CODES

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Verify the readable mirror and report local drift')
    .action(async () => {
      const startedAt = new Date().toISOString()
      const progress = createProgressIndicator()
      let result: Record<string, unknown>
      let category: StatusCategory = 'success'
      try {
        const resolved = resolveBackupConfiguration(loadConfigStrict())
        progress.start('Verifying mirror')
        const inspected = await inspectMirror(resolved.mirrorPath, resolved.plan)
        progress.stop()
        if (!isQuiet()) {
          for (const line of formatMirrorDiff(inspected.diff, 'Local drift')) console.error(line)
        }
        const drifted = inspected.diff.length > 0
        category = drifted ? 'warning' : 'success'
        result = {
          operation: 'status',
          state: drifted ? 'degraded' : 'success',
          category,
          startedAt,
          endedAt: new Date().toISOString(),
          mirrorPath: resolved.mirrorPath,
          counts: {
            sources: inspected.manifest.sources.length,
            files: inspected.manifest.entries.filter((entry) => entry.type === 'file').length,
            drift: inspected.diff.length,
          },
          issues: drifted
            ? [
                {
                  code: 'MIRROR_DRIFT',
                  category: 'warning',
                  message: 'Local sources differ from the synchronized mirror',
                  nextAction: 'Run backup to update the mirror or restore to recover local sources',
                },
              ]
            : [],
          nextAction: drifted ? 'Review the displayed diff' : null,
        }
      } catch (error) {
        progress.stop()
        const known = error instanceof MirrorError ? error : undefined
        category = (known?.category ?? 'internal') as StatusCategory
        result = {
          operation: 'status',
          state: 'failure',
          category,
          startedAt,
          endedAt: new Date().toISOString(),
          issues: [
            {
              code: known?.code ?? 'STATUS_FAILED',
              category,
              message: known?.message ?? 'Mirror status could not be determined',
            },
          ],
          nextAction: 'Run backup --dry-run and inspect the mirror configuration',
        }
        console.error(`status: ${(result.issues as Array<{ code: string }>)[0]?.code}`)
      }
      emitCliResult(program, (value) => console.log(value), result)
      process.exitCode = EXIT_CODES[category]
    })
}
