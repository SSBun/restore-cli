import type { Command } from 'commander'
import { loadConfigStrict, resolveBackupConfiguration } from '../config/loader.js'
import type { ResolvedBackupConfiguration } from '../config/loader.js'
import { MirrorError, synchronizeMirror } from '../mirror/index.js'
import { preparePlugins } from '../plugin/prepare.js'
import { color } from '../util/color.js'
import { isQuiet } from '../util/log.js'
import { createProgressIndicator } from '../util/progress.js'
import { emitCliResult } from '../util/result.js'
import { formatBackupHeader, formatCaptureScope, formatMirrorDiff } from './backup-format.js'

const EXIT_CODES = {
  success: 0,
  warning: 2,
  configuration: 10,
  source: 13,
  destination: 14,
  integrity: 15,
  internal: 20,
} as const

type BackupCategory = keyof typeof EXIT_CODES

export interface BackupCommandDependencies {
  resolveConfiguration(): ResolvedBackupConfiguration
  synchronize: typeof synchronizeMirror
  prepare: typeof preparePlugins
  progress(): ReturnType<typeof createProgressIndicator>
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

const DEFAULT_DEPENDENCIES: BackupCommandDependencies = {
  resolveConfiguration: () => resolveBackupConfiguration(loadConfigStrict()),
  synchronize: synchronizeMirror,
  prepare: preparePlugins,
  progress: createProgressIndicator,
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
  setExitCode: (value) => {
    process.exitCode = value
  },
}

function failure(error: unknown, startedAt: string) {
  const known = error instanceof MirrorError ? error : undefined
  const category: BackupCategory = known?.category ?? 'internal'
  return {
    operation: 'backup',
    state: 'failure',
    category,
    startedAt,
    endedAt: new Date().toISOString(),
    issues: [
      {
        code: known?.code ?? 'BACKUP_FAILED',
        category,
        message: known?.message ?? 'Mirror backup failed',
      },
    ],
    nextAction:
      known?.code === 'LEGACY_REPOSITORY_PRESENT'
        ? 'Review with --dry-run --replace, then rerun with --replace'
        : 'Resolve the reported issue and retry',
  }
}

export function registerBackupCommand(
  program: Command,
  overrides: Partial<BackupCommandDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  program
    .command('backup')
    .description('Synchronize the latest readable mirror')
    .option('--dry-run', 'show changes without writing the mirror')
    .option('--replace', 'replace an existing legacy repository after review')
    .action(async (options: { dryRun?: boolean; replace?: boolean }) => {
      const startedAt = new Date().toISOString()
      let result: Record<string, unknown>
      let exitCategory: BackupCategory = 'success'
      let progress: ReturnType<typeof createProgressIndicator> | undefined
      try {
        const resolved = dependencies.resolveConfiguration()
        if (resolved.plugins.length === 0) {
          throw new MirrorError('NO_SOURCES_SELECTED', 'configuration', 'No plugins are selected')
        }
        if (!isQuiet()) {
          for (const line of formatBackupHeader(
            resolved.config.destination.name,
            resolved.mirrorPath,
          )) {
            dependencies.writeStderr(line)
          }
          for (const line of formatCaptureScope(resolved.plan)) dependencies.writeStderr(line)
          dependencies.writeStderr(
            `\n${color.yellow('!')} ${color.bold('Readable mirror')} ${color.dim('— files are not encrypted')}`,
          )
        }

        progress = dependencies.progress()
        if (!options.dryRun) {
          progress.start('Preparing generated inventories')
          await dependencies.prepare(resolved.plugins, {
            onPrepareStart(pluginName, current, total) {
              progress?.update(`Preparing plugins · ${current}/${total} ${pluginName}`)
            },
          })
        } else {
          progress.start('Scanning current sources')
        }
        const synchronized = await dependencies.synchronize({
          root: resolved.mirrorPath,
          plan: resolved.plan,
          dryRun: options.dryRun === true,
          replaceLegacy: options.replace === true,
          onPhase: (message) => progress?.update(message),
        })
        progress.stop()
        progress = undefined
        if (!isQuiet()) {
          for (const line of formatMirrorDiff(synchronized.diff)) dependencies.writeStderr(line)
        }
        const counts = {
          created: synchronized.diff.filter((entry) => entry.action === 'create').length,
          modified: synchronized.diff.filter((entry) => entry.action === 'modify').length,
          deleted: synchronized.diff.filter((entry) => entry.action === 'delete').length,
          files: synchronized.manifest.entries.filter((entry) => entry.type === 'file').length,
        }
        result = {
          operation: 'backup',
          state: 'success',
          category: 'success',
          startedAt,
          endedAt: new Date().toISOString(),
          mirrorPath: resolved.mirrorPath,
          dryRun: options.dryRun === true,
          changed: synchronized.changed,
          wouldChange: synchronized.diff.length > 0 || synchronized.repaired,
          repaired: synchronized.repaired,
          legacyRepositoryDetected: synchronized.replacedLegacy,
          replacedLegacy: synchronized.replacedLegacy && synchronized.changed,
          counts,
          issues: [],
          nextAction:
            options.dryRun && (synchronized.diff.length > 0 || synchronized.repaired)
              ? 'Run backup to synchronize these changes'
              : null,
        }
      } catch (error) {
        progress?.stop()
        result = failure(error, startedAt)
        exitCategory = result.category as BackupCategory
        dependencies.writeStderr(`backup: ${(result.issues as Array<{ code: string }>)[0]?.code}`)
      }
      emitCliResult(program, dependencies.writeStdout, result)
      dependencies.setExitCode(EXIT_CODES[exitCategory])
    })
}
