import type { Command } from 'commander'
import { MacOsKeychainCredentialProvider } from '../protection/index.js'
import type { CredentialProvider } from '../protection/index.js'
import { APPLY_FIDELITY_CONSENT, applyStaging, rollbackSafetyPoint } from '../recovery/index.js'
import type {
  ApplyOptions,
  ApplyResult,
  ConflictPolicy,
  RollbackOptions,
} from '../recovery/index.js'
import type { OperationCategory } from '../repository/index.js'

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

export interface ApplyV1CommandDependencies {
  apply: typeof applyStaging
  rollback: typeof rollbackSafetyPoint
  credentialProvider(): CredentialProvider
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

const DEFAULT_DEPENDENCIES: ApplyV1CommandDependencies = {
  apply: applyStaging,
  rollback: rollbackSafetyPoint,
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

function failure(operation: 'apply' | 'rollback', startedAt: string): ApplyResult {
  return {
    operation,
    state: 'failure',
    category: 'configuration',
    dryRun: true,
    startedAt,
    endedAt: new Date().toISOString(),
    repositoryId: 'unknown',
    protection: 'encrypted',
    pointId: '',
    stagingId: '',
    applyId: '',
    safetyId: null,
    conflictPolicy: 'error',
    planFingerprint: '',
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
    items: [],
    issues: [
      {
        code: `${operation.toUpperCase()}_CONFIGURATION_INVALID`,
        category: 'configuration',
        message: `${operation} arguments are invalid`,
      },
    ],
    nextAction: 'Provide explicit repository, staging, and target bindings',
  }
}

function repositoryOptions(
  values: {
    repository?: string
    repositoryId?: string
    protection?: string
  },
  dependencies: ApplyV1CommandDependencies,
) {
  if (!values.repository || !values.repositoryId || !values.protection) throw new Error('required')
  if (values.protection !== 'encrypted' && values.protection !== 'plaintext')
    throw new Error('mode')
  const protection: 'encrypted' | 'plaintext' = values.protection
  return {
    repositoryPath: values.repository,
    expectedRepositoryId: values.repositoryId,
    expectedProtection: protection,
    ...(protection === 'encrypted'
      ? { credentialProvider: dependencies.credentialProvider() }
      : {}),
  }
}

function dryRun(values: { execute?: boolean; dryRun?: boolean }): boolean {
  if (values.execute && values.dryRun) throw new Error('conflicting mutation flags')
  return values.execute !== true
}

/** V1 command registration is intentionally not root-wired until the T8 CLI integration task. */
export function registerV1ApplyCommands(
  program: Command,
  overrides: Partial<ApplyV1CommandDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  program
    .command('apply-v1')
    .description('Dry-run or explicitly apply verified v1 staging')
    .option('--repository <path>')
    .option('--repository-id <id>')
    .option('--protection <mode>')
    .option('--staging <path>')
    .option('--target <source-id=absolute-path>', 'explicit source target mapping', collect, [])
    .option('--overwrite', 'atomically replace conflicting regular files or links')
    .option('--skip', 'explicitly skip conflicting entries')
    .option('--apply-id <id>', 'resume only this bound apply journal')
    .option(
      '--accept-staging-fidelity-issues <token>',
      `required exact execution consent: ${APPLY_FIDELITY_CONSENT}`,
    )
    .option('--dry-run', 'plan only; this is the default')
    .option('--execute', 'perform the reviewed destructive apply')
    .action(
      async (values: {
        repository?: string
        repositoryId?: string
        protection?: string
        staging?: string
        target: string[]
        overwrite?: boolean
        skip?: boolean
        applyId?: string
        acceptStagingFidelityIssues?: string
        dryRun?: boolean
        execute?: boolean
      }) => {
        const startedAt = new Date().toISOString()
        try {
          if (!values.staging || values.target.length === 0) throw new Error('required')
          if (values.overwrite && values.skip) throw new Error('policy')
          const conflictPolicy: ConflictPolicy = values.overwrite
            ? 'overwrite'
            : values.skip
              ? 'skip'
              : 'error'
          const targets = values.target.map((target) => {
            const separator = target.indexOf('=')
            if (separator < 1) throw new Error('target')
            return { sourceId: target.slice(0, separator), targetPath: target.slice(separator + 1) }
          })
          const options: ApplyOptions = {
            ...repositoryOptions(values, dependencies),
            stagingPath: values.staging,
            targets,
            conflictPolicy,
            dryRun: dryRun(values),
            ...(values.applyId ? { applyId: values.applyId } : {}),
            ...(values.acceptStagingFidelityIssues
              ? { fidelityConsent: values.acceptStagingFidelityIssues }
              : {}),
          }
          const result = await dependencies.apply(options)
          if (result.issues[0]) dependencies.writeStderr(`apply-v1: ${result.issues[0].code}`)
          dependencies.writeStdout(JSON.stringify(result))
          dependencies.setExitCode(EXIT_CODES[result.category])
        } catch {
          const result = failure('apply', startedAt)
          dependencies.writeStderr('apply-v1: APPLY_CONFIGURATION_INVALID')
          dependencies.writeStdout(JSON.stringify(result))
          dependencies.setExitCode(EXIT_CODES.configuration)
        }
      },
    )

  program
    .command('rollback-v1')
    .description('Dry-run or explicitly rollback one durable Safety Point')
    .option('--repository <path>')
    .option('--repository-id <id>')
    .option('--protection <mode>')
    .option('--staging <path>')
    .option('--safety-id <id>')
    .option('--delete-newly-created', 'explicitly delete paths that were absent before apply')
    .option('--dry-run', 'plan only; this is the default')
    .option('--execute', 'perform the reviewed destructive rollback')
    .action(
      async (values: {
        repository?: string
        repositoryId?: string
        protection?: string
        staging?: string
        safetyId?: string
        deleteNewlyCreated?: boolean
        dryRun?: boolean
        execute?: boolean
      }) => {
        const startedAt = new Date().toISOString()
        try {
          if (!values.staging || !values.safetyId) throw new Error('required')
          const options: RollbackOptions = {
            ...repositoryOptions(values, dependencies),
            stagingPath: values.staging,
            safetyId: values.safetyId,
            dryRun: dryRun(values),
            deleteNewlyCreated: values.deleteNewlyCreated === true,
          }
          const result = await dependencies.rollback(options)
          if (result.issues[0]) dependencies.writeStderr(`rollback-v1: ${result.issues[0].code}`)
          dependencies.writeStdout(JSON.stringify(result))
          dependencies.setExitCode(EXIT_CODES[result.category])
        } catch {
          const result = failure('rollback', startedAt)
          dependencies.writeStderr('rollback-v1: ROLLBACK_CONFIGURATION_INVALID')
          dependencies.writeStdout(JSON.stringify(result))
          dependencies.setExitCode(EXIT_CODES.configuration)
        }
      },
    )
}
