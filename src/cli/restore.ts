import type { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { MacOsKeychainCredentialProvider } from '../protection/index.js'
import type { CredentialProvider } from '../protection/index.js'
import { stageRecovery } from '../recovery/index.js'
import type { RecoveryResult, RecoverySelection, StageRecoveryOptions } from '../recovery/index.js'
import type { OperationCategory } from '../repository/index.js'
import { color } from '../util/color.js'
import { info } from '../util/log.js'
import { getBackupRoot } from '../util/path.js'
import { emitCliResult } from '../util/result.js'
import { registerV1ApplyCommands } from './apply.js'

const EXIT_CODES: Record<OperationCategory, number> = {
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

export interface RestoreCommandDependencies {
  stage: typeof stageRecovery
  credentialProvider(): CredentialProvider
  interactive(): boolean
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

const DEFAULT_DEPENDENCIES: RestoreCommandDependencies = {
  stage: stageRecovery,
  credentialProvider: () => new MacOsKeychainCredentialProvider(),
  interactive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
  setExitCode: (value) => {
    process.exitCode = value
  },
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function failedResult(startedAt: string): RecoveryResult {
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

function parseSelection(values: {
  plugin?: string
  source: string[]
  path: string[]
  acceptPartial?: boolean
  point?: string
}): RecoverySelection {
  const selectors = [
    Boolean(values.plugin),
    values.source.length > 0,
    values.path.length > 0,
  ].filter(Boolean)
  if (selectors.length > 1 || (values.acceptPartial && !values.point)) throw new Error('selector')
  if (values.plugin) return { kind: 'plugin', plugin: values.plugin }
  if (values.source.length > 0) return { kind: 'sources', sourceIds: values.source }
  if (values.path.length > 0) {
    return {
      kind: 'paths',
      paths: values.path.map((path) => {
        const separator = path.indexOf('=')
        if (separator < 1) throw new Error('path')
        return { sourceId: path.slice(0, separator), relativePath: path.slice(separator + 1) }
      }),
    }
  }
  return { kind: 'all' }
}

export function registerRestoreCommand(
  program: Command,
  overrides: Partial<RestoreCommandDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const restore = program
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
          let repoPath = values.repository
          let repoId = values.repositoryId
          let protection = values.protection
          const stagingRoot = values.staging
          if (!repoPath || !repoId || !protection) {
            try {
              const config = loadConfig()
              if (config.repository) {
                repoPath ??= getBackupRoot(config.destination.path)
                repoId ??= config.repository.id
                protection ??= config.repository.protection
              }
            } catch {
              // config not available
            }
          }
          if (!repoPath || !repoId || !protection || !stagingRoot || values.dryRun)
            throw new Error('required')
          if (protection !== 'encrypted' && protection !== 'plaintext') throw new Error('mode')
          const selection = parseSelection(values)
          const options: StageRecoveryOptions = {
            repositoryPath: repoPath,
            expectedRepositoryId: repoId,
            expectedProtection: protection,
            ...(protection === 'encrypted'
              ? { credentialProvider: dependencies.credentialProvider() }
              : {}),
            stagingRoot,
            ...(values.point ? { pointId: values.point } : {}),
            selection,
            ...(values.acceptPartial
              ? { allowPartial: true, partialConsent: 'I_ACCEPT_PARTIAL_RECOVERY' as const }
              : {}),
          }
          const result = await dependencies.stage(options)
          if (result.issues[0]) dependencies.writeStderr(`restore-v1: ${result.issues[0].code}`)
          if (result.stagingPath) {
            info(`${color.green('\u2713')} Staged to: ${color.bold(result.stagingPath)}`)
            info(
              `${color.dim('Next:')} restore-cli restore apply --staging ${result.stagingPath} --target <source-id>=<path> --execute`,
            )
          }
          emitCliResult(program, dependencies.writeStdout, result)
          dependencies.setExitCode(EXIT_CODES[result.category])
        } catch {
          const result = failedResult(startedAt)
          dependencies.writeStderr('restore-v1: RESTORE_CONFIGURATION_INVALID')
          emitCliResult(program, dependencies.writeStdout, result)
          dependencies.setExitCode(EXIT_CODES.configuration)
        }
      },
    )

  registerV1ApplyCommands(restore)
}
