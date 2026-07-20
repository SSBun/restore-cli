import type { Command } from 'commander'
import { loadConfigStrict, resolveBackupConfiguration } from '../config/loader.js'
import type { ResolvedBackupConfiguration } from '../config/loader.js'
import { createV1RecoveryPoint } from '../engine/v1-backup.js'
import { preparePlugins } from '../plugin/prepare.js'
import { MacOsKeychainCredentialProvider } from '../protection/index.js'
import type { CredentialProvider } from '../protection/index.js'
import { createOperationResult } from '../repository/index.js'
import type { OperationCategory, OperationResult } from '../repository/index.js'
import { color } from '../util/color.js'
import { emitCliResult } from '../util/result.js'
import { formatBackupHeader, formatCaptureScope } from './backup-format.js'

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

function cliFailure(
  category: 'configuration' | 'internal',
  startedAt: string,
  repositoryId?: string,
): OperationResult {
  const code =
    category === 'configuration' ? 'BACKUP_CONFIGURATION_INVALID' : 'BACKUP_SERVICE_FAILED'
  const message =
    category === 'configuration'
      ? 'Backup configuration could not be resolved safely'
      : 'Backup service did not produce a result'
  return createOperationResult({
    operation: 'backup',
    state: 'failure',
    category,
    ...(repositoryId ? { repositoryId } : {}),
    startedAt,
    endedAt: new Date().toISOString(),
    issues: [{ code, category, message }],
  })
}

export interface BackupCommandDependencies {
  resolveConfiguration(): ResolvedBackupConfiguration
  createRecoveryPoint: typeof createV1RecoveryPoint
  prepare: typeof preparePlugins
  credentialProvider(): CredentialProvider
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

const DEFAULT_DEPENDENCIES: BackupCommandDependencies = {
  resolveConfiguration: () => resolveBackupConfiguration(loadConfigStrict()),
  createRecoveryPoint: createV1RecoveryPoint,
  prepare: preparePlugins,
  credentialProvider: () => new MacOsKeychainCredentialProvider(),
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
  setExitCode: (value) => {
    process.exitCode = value
  },
}

export function registerBackupCommand(
  program: Command,
  overrides: Partial<BackupCommandDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  program
    .command('backup')
    .description('Create a verified v1 recovery point')
    .option('--dry-run', 'Resolve and capture the same source plan without repository writes')
    .option('--point-id <id>', 'Explicit stable recovery point ID')
    .action(async (options: { dryRun?: boolean; pointId?: string }) => {
      const startedAt = new Date().toISOString()
      let phase: 'configuration' | 'internal' = 'configuration'
      let repositoryId: string | undefined
      try {
        const resolved = dependencies.resolveConfiguration()
        if (!resolved.config.repository) {
          throw new Error('repository configuration missing')
        }
        repositoryId = resolved.config.repository.id
        if (resolved.plugins.length === 0) throw new Error('no enabled plugins')
        for (const line of formatBackupHeader(
          resolved.config.destination.name,
          resolved.repositoryPath,
        )) {
          dependencies.writeStderr(line)
        }
        for (const line of formatCaptureScope(resolved.plan)) dependencies.writeStderr(line)
        if (resolved.config.repository.protection === 'plaintext') {
          dependencies.writeStderr(
            `\n${color.yellow('!')} ${color.bold('Plaintext repository')} ${color.dim('— content and metadata are not encrypted')}`,
          )
        }

        phase = 'internal'
        const result = await dependencies.createRecoveryPoint({
          repositoryPath: resolved.repositoryPath,
          expectedRepositoryId: resolved.config.repository.id,
          expectedProtection: resolved.config.repository.protection,
          ...(resolved.config.repository.protection === 'encrypted'
            ? { credentialProvider: dependencies.credentialProvider() }
            : {}),
          plan: resolved.plan,
          plaintextSecretAcceptances: resolved.config.plaintextSecretAcceptances,
          ...(options.pointId ? { pointId: options.pointId } : {}),
          dryRun: Boolean(options.dryRun),
          ...(!options.dryRun
            ? { beforeCapture: async () => dependencies.prepare(resolved.plugins) }
            : {}),
        })
        emitCliResult(program, dependencies.writeStdout, result)
        dependencies.setExitCode(EXIT_CODES[result.category])
      } catch {
        const result = cliFailure(phase, startedAt, repositoryId)
        dependencies.writeStderr(`backup: ${result.issues[0]?.code ?? 'BACKUP_SERVICE_FAILED'}`)
        emitCliResult(program, dependencies.writeStdout, result)
        dependencies.setExitCode(EXIT_CODES[result.category])
      }
    })
}
