import type { Command } from 'commander'
import type { CredentialProvider } from '../protection/index.js'
import {
  ProtectionAuthenticationError,
  ProtectionError,
  importRecoverySecretBytes,
  parseWrappedMasterKey,
  unwrapMasterKey,
} from '../protection/index.js'
import {
  RecoveryPlanError,
  executeRecoveryInstallPlan,
  generateRecoveryPlan,
} from '../recovery-plan/index.js'
import type {
  ExecuteRecoveryInstallOptions,
  InstallPhase,
  RecoveryInstallResult,
  RecoveryPlan,
  RecoveryPlanOptions,
} from '../recovery-plan/index.js'
import { RecoveryFailure } from '../recovery/index.js'
import { RepositoryError, getRepositoryLayout } from '../repository/index.js'
import type { OperationCategory, ProtectionMode } from '../repository/index.js'
import { readBoundedRegularFile } from '../repository/io.js'

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

export interface RecoverCommandDependencies {
  plan: typeof generateRecoveryPlan
  install: typeof executeRecoveryInstallPlan
  recoveryCredential(repositoryPath: string, recoveryFile: string): CredentialProvider
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

class RecoveryFileCredentialProvider implements CredentialProvider {
  constructor(
    private readonly repositoryPath: string,
    private readonly recoveryFile: string,
  ) {}

  async loadMasterKey(repositoryId: string) {
    let wrappedPayload: Buffer | undefined
    let recoveryPayload: Buffer | undefined
    let recoverySecret: ReturnType<typeof importRecoverySecretBytes> | undefined
    try {
      try {
        recoveryPayload = await readBoundedRegularFile(this.recoveryFile, 1024)
        recoverySecret = importRecoverySecretBytes(recoveryPayload)
      } catch {
        throw new ProtectionAuthenticationError()
      }
      let wrapped: ReturnType<typeof parseWrappedMasterKey>
      try {
        wrappedPayload = await readBoundedRegularFile(
          getRepositoryLayout(this.repositoryPath).recoveryKey,
          64 * 1024,
        )
        wrapped = parseWrappedMasterKey(JSON.parse(wrappedPayload.toString('utf8')))
      } catch (error) {
        if (error instanceof ProtectionError) throw error
        throw new ProtectionError(
          'RECOVERY_WRAPPED_KEY_INVALID',
          'Repository recovery key wrapper is missing or invalid',
        )
      }
      return await unwrapMasterKey(repositoryId, wrapped, recoverySecret)
    } finally {
      recoverySecret?.dispose()
      wrappedPayload?.fill(0)
      recoveryPayload?.fill(0)
    }
  }

  async storeMasterKey(): Promise<void> {
    throw new Error('Recovery command never stores credentials')
  }

  async deleteMasterKey(): Promise<void> {
    throw new Error('Recovery command never deletes credentials')
  }
}

const DEFAULT_DEPENDENCIES: RecoverCommandDependencies = {
  plan: generateRecoveryPlan,
  install: executeRecoveryInstallPlan,
  recoveryCredential: (repositoryPath, recoveryFile) =>
    new RecoveryFileCredentialProvider(repositoryPath, recoveryFile),
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
  setExitCode: (value) => {
    process.exitCode = value
  },
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function protection(value: string): ProtectionMode {
  if (value !== 'encrypted' && value !== 'plaintext') {
    throw new RecoveryPlanError(
      'configuration',
      'RECOVERY_PROTECTION_INVALID',
      'Protection must be encrypted or plaintext',
    )
  }
  return value
}

function phases(values: string[]): InstallPhase[] {
  if (values.some((value) => value !== 'homebrew' && value !== 'vscode')) {
    throw new RecoveryPlanError(
      'configuration',
      'INSTALL_PHASE_INVALID',
      'Install phase must be homebrew or vscode',
    )
  }
  return values as InstallPhase[]
}

function failure(
  error: unknown,
  operation: 'recovery-plan' | 'recovery-install',
  values?: Partial<RecoverCliValues>,
) {
  const nodeCode = error instanceof Error && 'code' in error ? String(error.code) : null
  const knownPlan = error instanceof RecoveryPlanError
  const knownRepository = error instanceof RepositoryError
  const knownRecovery = error instanceof RecoveryFailure
  const authentication = error instanceof ProtectionAuthenticationError
  const protectionFailure = error instanceof ProtectionError
  const category: Exclude<OperationCategory, 'success'> = knownPlan
    ? error.category
    : knownRepository
      ? error.category
      : knownRecovery
        ? error.category
        : authentication
          ? 'authentication'
          : protectionFailure
            ? 'integrity'
            : nodeCode === 'ENOENT'
              ? 'configuration'
              : nodeCode === 'EACCES' || nodeCode === 'EPERM'
                ? 'source'
                : 'internal'
  const fallbackCode =
    operation === 'recovery-install' ? 'RECOVERY_INSTALL_FAILED' : 'RECOVERY_PLAN_FAILED'
  const candidateCode = knownPlan
    ? error.code
    : knownRepository
      ? error.code
      : knownRecovery
        ? error.code
        : authentication
          ? 'RECOVERY_AUTHENTICATION_FAILED'
          : protectionFailure
            ? 'RECOVERY_PROTECTION_FAILED'
            : nodeCode === 'ENOENT'
              ? 'RECOVERY_INPUT_MISSING'
              : nodeCode === 'EACCES' || nodeCode === 'EPERM'
                ? 'RECOVERY_INPUT_UNREADABLE'
                : fallbackCode
  const code = /^[A-Z0-9_]{1,100}$/.test(candidateCode) ? candidateCode : fallbackCode
  const message =
    category === 'authentication'
      ? 'Recovery authentication failed'
      : category === 'configuration'
        ? 'Required recovery input or configuration is missing or invalid'
        : category === 'source'
          ? 'A required recovery input could not be read safely'
          : category === 'integrity'
            ? 'Recovery data failed an integrity check'
            : operation === 'recovery-install'
              ? 'Recovery installation did not complete safely'
              : 'Recovery planning did not complete safely'
  const timestamp = new Date().toISOString()
  const issue = { code, category, message, nextAction: 'Resolve the reported condition and retry' }
  if (operation === 'recovery-install') {
    return {
      operation: 'recovery-install' as const,
      state: 'failure' as const,
      category,
      dryRun: values?.executeInstall !== true,
      startedAt: timestamp,
      endedAt: timestamp,
      repositoryId: values?.repositoryId ?? null,
      pointId: values?.point ?? null,
      planFingerprint: values?.approvePlan ?? null,
      items: [],
      counts: {
        total: 0,
        pending: 0,
        succeeded: 0,
        alreadyPresent: 0,
        failed: 0,
        manual: 0,
        skipped: 0,
      },
      issues: [issue],
      nextAction: issue.nextAction,
    }
  }
  return {
    formatVersion: 1 as const,
    operation: 'recovery-plan' as const,
    state: 'failure',
    category,
    dryRun: true as const,
    startedAt: timestamp,
    endedAt: timestamp,
    repository: {
      path: null,
      id: values?.repositoryId ?? null,
      protection:
        values?.protection === 'encrypted' || values?.protection === 'plaintext'
          ? values.protection
          : null,
      authenticated: false,
    },
    recoveryPoint: {
      id: values?.point ?? null,
      healthy: false,
      fixed: false,
      contentVerified: false,
      manifestFingerprint: null,
    },
    staging: { id: null, path: null, verified: false, selectionFingerprint: null },
    configuration: { items: [], stagedOnly: true, originalPathsChanged: false },
    software: [],
    allowlistedActions: [],
    manualDependencies: [],
    phases: [],
    fingerprint: null,
    issues: [issue],
    nextAction: issue.nextAction,
  }
}

interface RecoverCliValues {
  repository: string
  repositoryId: string
  protection: string
  recoveryFile?: string
  stagingRoot: string
  point?: string
  installPhase: string[]
  confirmPhase: string[]
  executeInstall?: boolean
  approvePlan?: string
  stateDirectory?: string
}

/** Defined for T8 root wiring; this module does not register itself globally. */
export function registerRecoverCommand(
  program: Command,
  overrides: Partial<RecoverCommandDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  program
    .command('recover')
    .description('Build an authenticated new-Mac recovery plan; installs are opt-in')
    .requiredOption('--repository <path>', 'RestoreBackup repository path')
    .requiredOption('--repository-id <id>', 'expected repository identity')
    .requiredOption('--protection <mode>', 'encrypted or plaintext')
    .option('--recovery-file <path>', 'independent recovery credential; required for encryption')
    .requiredOption('--staging-root <path>', 'existing private root for verified staging')
    .option('--point <id>', 'fixed healthy recovery point; defaults to latest healthy')
    .option('--install-phase <phase>', 'homebrew or vscode; repeat to select both', collect, [])
    .option(
      '--confirm-phase <phase>',
      'explicit phase confirmation; repeat to select both',
      collect,
      [],
    )
    .option('--execute-install', 'execute selected allowlisted installers; default is report only')
    .option('--approve-plan <sha256>', 'exact reviewed recovery-plan fingerprint')
    .option('--state-directory <path>', 'existing private resume-journal directory')
    .action(async (values: RecoverCliValues) => {
      let output: RecoveryPlan | RecoveryInstallResult | ReturnType<typeof failure>
      const requestedInstall = values.installPhase.length > 0
      try {
        const mode = protection(values.protection)
        if (mode === 'encrypted' && !values.recoveryFile) {
          throw new RecoveryPlanError(
            'configuration',
            'RECOVERY_CREDENTIAL_REQUIRED',
            'Encrypted blank-profile recovery requires an independent recovery credential file',
          )
        }
        if (mode === 'plaintext' && values.recoveryFile) {
          throw new RecoveryPlanError(
            'configuration',
            'RECOVERY_CREDENTIAL_NOT_APPLICABLE',
            'A plaintext repository does not use a recovery credential',
          )
        }
        const selectedPhases = phases(values.installPhase)
        const confirmedPhases = phases(values.confirmPhase)
        const common: RecoveryPlanOptions = {
          repositoryPath: values.repository,
          expectedRepositoryId: values.repositoryId,
          expectedProtection: mode,
          stagingRoot: values.stagingRoot,
          ...(values.point ? { pointId: values.point } : {}),
          ...(values.recoveryFile
            ? {
                credentialProvider: dependencies.recoveryCredential(
                  values.repository,
                  values.recoveryFile,
                ),
              }
            : {}),
        }
        if (selectedPhases.length === 0) {
          if (
            values.executeInstall ||
            values.approvePlan ||
            values.stateDirectory ||
            confirmedPhases.length > 0
          ) {
            throw new RecoveryPlanError(
              'configuration',
              'INSTALL_PHASE_REQUIRED',
              'Install flags require at least one explicit install phase',
            )
          }
          output = await dependencies.plan(common)
        } else {
          const installOptions: ExecuteRecoveryInstallOptions = {
            ...common,
            phases: selectedPhases,
            confirmedPhases,
            execute: values.executeInstall === true,
            invocation: 'interactive-cli',
            ...(values.approvePlan ? { approvedPlanFingerprint: values.approvePlan } : {}),
            ...(values.stateDirectory ? { stateDirectory: values.stateDirectory } : {}),
          }
          output = await dependencies.install(installOptions)
        }
      } catch (error) {
        output = failure(error, requestedInstall ? 'recovery-install' : 'recovery-plan', values)
      }
      if (output.category !== 'success') {
        dependencies.writeStderr(`recover: ${output.issues[0]?.code ?? 'RECOVERY_FAILED'}`)
      }
      dependencies.writeStdout(JSON.stringify(output))
      dependencies.setExitCode(EXIT_CODES[output.category])
    })
}
