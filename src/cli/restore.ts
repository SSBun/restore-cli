import * as p from '@clack/prompts'
import { isCancel } from '@clack/prompts'
import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { getSnapshotInfo, planRestoreFromSnapshot, restoreFromSnapshot } from '../engine/restore.js'
import { getEnabledPlugins } from '../plugin/loader.js'
import { getBuiltinPlugin } from '../plugin/registry.js'
import { MacOsKeychainCredentialProvider } from '../protection/index.js'
import type { CredentialProvider } from '../protection/index.js'
import { stageRecovery } from '../recovery/index.js'
import type { RecoveryResult, RecoverySelection, StageRecoveryOptions } from '../recovery/index.js'
import type { OperationCategory } from '../repository/index.js'
import { error, info } from '../util/log.js'
import { getBackupRoot } from '../util/path.js'
import { emitCliResult } from '../util/result.js'

function printRestorePlan(files: { relativePath: string; destinationPath: string }[]): void {
  info(`Restore plan (${files.length} files):`)
  for (const file of files) {
    info(`  ${file.relativePath} -> ${file.destinationPath}`)
  }
}

export function registerRestoreCommand(program: Command): void {
  program
    .command('legacy-restore')
    .description('Compatibility restore from a read-only 0.1.x snapshot')
    .option('--snapshot <name>', 'Snapshot name to restore from')
    .option('--list', 'List available snapshots')
    .option('--dry-run', 'Show what would be restored without copying')
    .option('--plugin <name>', 'Restore only paths for a known plugin')
    .option('--to <dir>', 'Restore files under a target directory instead of original paths')
    .action(async (options) => {
      const config = loadConfig()
      const backupRoot = getBackupRoot(config.destination.path)
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

      const plugins = getEnabledPlugins(config.plugins)
      let restoreRoots = plugins.flatMap((plugin) => plugin.paths)
      if (options.plugin) {
        const plugin = getBuiltinPlugin(options.plugin)
        if (!plugin) {
          error(`Unknown plugin "${options.plugin}"`)
          process.exit(1)
        }
        restoreRoots = plugin.paths
      }

      const restoreOptions = { toDir: options.to }
      const plan = await planRestoreFromSnapshot(snapshot.path, restoreRoots, restoreOptions)
      printRestorePlan(plan)

      if (options.dryRun) {
        info('Dry run only. No files were restored.')
        return
      }

      const destination = options.to ? ` under ${options.to}` : ''
      const confirm = await p.confirm({
        message: `Restore ${plan.length} files from ${snapshotName}${destination}? This may OVERWRITE existing files.`,
        initialValue: false,
      })
      if (isCancel(confirm) || !confirm) {
        p.cancel('Restore cancelled')
        process.exit(0)
      }

      const { restored } = await restoreFromSnapshot(snapshot.path, restoreRoots, restoreOptions)
      info(`Restored ${restored} files from ${snapshotName}`)
    })
}

const V1_EXIT_CODES: Record<OperationCategory, number> = {
  success: 0,
  warning: 2,
  partial: 3,
  configuration: 10,
  authentication: 11,
  lock: 12,
  source: 13,
  destination: 14,
  integrity: 15,
  unsupported: 16,
  cancelled: 17,
  internal: 20,
}

export interface RestoreV1CommandDependencies {
  stage: typeof stageRecovery
  credentialProvider(): CredentialProvider
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

const DEFAULT_V1_DEPENDENCIES: RestoreV1CommandDependencies = {
  stage: stageRecovery,
  credentialProvider: () => new MacOsKeychainCredentialProvider(),
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
  setExitCode: (value) => {
    process.exitCode = value
  },
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function failedV1Result(startedAt: string): RecoveryResult {
  return {
    operation: 'stage-recovery',
    state: 'failure',
    category: 'configuration',
    startedAt,
    endedAt: new Date().toISOString(),
    repositoryId: 'unknown',
    protection: 'encrypted',
    pointId: null,
    stagingId: null,
    stagingPath: null,
    partialAccepted: false,
    selection: { kind: 'all' },
    plugins: [],
    sources: [],
    selectedPaths: [],
    limitations: ['No original path was modified'],
    counts: {
      filesConsidered: 0,
      restored: 0,
      unchanged: 0,
      skipped: 0,
      conflicted: 0,
      failed: 0,
      fidelityLoss: 0,
      bytesRead: 0,
      bytesWritten: 0,
      bytesVerified: 0,
    },
    issues: [
      {
        code: 'RESTORE_CONFIGURATION_INVALID',
        category: 'configuration',
        message: 'Restore arguments are invalid',
      },
    ],
    nextAction: 'Provide an explicit repository identity and staging root',
  }
}

export function registerV1RestoreCommand(
  program: Command,
  overrides: Partial<RestoreV1CommandDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_V1_DEPENDENCIES, ...overrides }
  program
    .command('restore')
    .alias('restore-v1')
    .description('Restore an authenticated v1 recovery point into isolated staging')
    .option('--repository <path>', 'existing RestoreBackup repository path')
    .option('--repository-id <id>', 'expected immutable repository ID')
    .option('--protection <mode>', 'encrypted or plaintext')
    .option('--staging <path>', 'existing explicit staging root')
    .option('--point <id>', 'immutable point ID; defaults to latest healthy')
    .option('--plugin <name>', 'select one declared plugin')
    .option('--source <id>', 'select a declared source', collect, [])
    .option('--path <source-id=relative-path>', 'select a declared manifest path', collect, [])
    .option('--accept-partial', 'dangerously accept an explicitly selected partial point')
    .option('--dry-run', 'reject staging writes and return a configuration result')
    .action(
      async (values: {
        repository?: string
        repositoryId?: string
        protection?: string
        staging?: string
        point?: string
        plugin?: string
        source: string[]
        path: string[]
        acceptPartial?: boolean
        dryRun?: boolean
      }) => {
        const startedAt = new Date().toISOString()
        try {
          if (
            !values.repository ||
            !values.repositoryId ||
            !values.protection ||
            !values.staging ||
            values.dryRun
          )
            throw new Error('required')
          if (values.protection !== 'encrypted' && values.protection !== 'plaintext')
            throw new Error('mode')
          const selectors = [
            Boolean(values.plugin),
            values.source.length > 0,
            values.path.length > 0,
          ].filter(Boolean)
          if (selectors.length > 1 || (values.acceptPartial && !values.point))
            throw new Error('selector')
          let selection: RecoverySelection = { kind: 'all' }
          if (values.plugin) selection = { kind: 'plugin', plugin: values.plugin }
          else if (values.source.length > 0)
            selection = { kind: 'sources', sourceIds: values.source }
          else if (values.path.length > 0) {
            selection = {
              kind: 'paths',
              paths: values.path.map((path) => {
                const separator = path.indexOf('=')
                if (separator < 1) throw new Error('path')
                return {
                  sourceId: path.slice(0, separator),
                  relativePath: path.slice(separator + 1),
                }
              }),
            }
          }
          const options: StageRecoveryOptions = {
            repositoryPath: values.repository,
            expectedRepositoryId: values.repositoryId,
            expectedProtection: values.protection,
            ...(values.protection === 'encrypted'
              ? { credentialProvider: dependencies.credentialProvider() }
              : {}),
            stagingRoot: values.staging,
            ...(values.point ? { pointId: values.point } : {}),
            selection,
            ...(values.acceptPartial
              ? { allowPartial: true, partialConsent: 'I_ACCEPT_PARTIAL_RECOVERY' as const }
              : {}),
          }
          const result = await dependencies.stage(options)
          if (result.issues[0]) dependencies.writeStderr(`restore-v1: ${result.issues[0].code}`)
          emitCliResult(program, dependencies.writeStdout, result)
          dependencies.setExitCode(V1_EXIT_CODES[result.category])
        } catch {
          const result = failedV1Result(startedAt)
          dependencies.writeStderr('restore-v1: RESTORE_CONFIGURATION_INVALID')
          emitCliResult(program, dependencies.writeStdout, result)
          dependencies.setExitCode(V1_EXIT_CODES.configuration)
        }
      },
    )
}
