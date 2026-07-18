import type { Command } from 'commander'
import { loadConfigStrict } from '../config/loader.js'
import { LegacyMigrationError, migrateLegacyRepository } from '../migration/index.js'
import type { LegacyMigrationReport } from '../migration/index.js'
import { MacOsKeychainCredentialProvider } from '../protection/index.js'
import type { CredentialProvider } from '../protection/index.js'
import type { OperationCategory, ProtectionMode } from '../repository/index.js'
import { getBackupRoot } from '../util/path.js'

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

export interface MigrateCommandConfiguration {
  repositoryPath: string
  repositoryId: string
  protection: ProtectionMode
}

export interface MigrateCommandDependencies {
  resolve(): MigrateCommandConfiguration
  migrate: typeof migrateLegacyRepository
  credentialProvider(): CredentialProvider
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

const DEFAULT_DEPENDENCIES: MigrateCommandDependencies = {
  resolve() {
    const config = loadConfigStrict()
    if (!config.repository) throw new Error('missing repository configuration')
    return {
      repositoryPath: getBackupRoot(config.destination.path),
      repositoryId: config.repository.id,
      protection: config.repository.protection,
    }
  },
  migrate: migrateLegacyRepository,
  credentialProvider: () => new MacOsKeychainCredentialProvider(),
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
  setExitCode: (value) => {
    process.exitCode = value
  },
}

function configurationFailure(legacyPath: string): LegacyMigrationReport {
  const now = new Date().toISOString()
  return {
    operation: 'legacy-migrate',
    startedAt: now,
    endedAt: now,
    dryRun: true,
    state: 'failure',
    category: 'configuration',
    counts: {
      filesConsidered: 0,
      filesWritten: 0,
      filesSkipped: 0,
      filesFailed: 0,
      bytesRead: 0,
      bytesWritten: 0,
    },
    verificationScope: 'structural',
    source: {
      repositoryPath: legacyPath,
      repositoryDigest: 'unknown',
      readOnly: true,
      deleted: false,
    },
    target: {
      repositoryPath: 'unknown',
      repositoryId: 'unknown',
      protection: 'encrypted',
      requiredBytes: '0',
      availableBytes: null,
      authenticated: false,
      capabilityChecked: false,
      lockChecked: false,
    },
    points: [],
    results: [
      {
        legacyPointId: 'configuration',
        targetPointId: 'none',
        state: 'failure',
        contentVerified: false,
        issues: [
          {
            code: 'MIGRATION_CONFIGURATION_INVALID',
            category: 'configuration',
            message: 'Migration configuration could not be resolved safely',
          },
        ],
      },
    ],
    unsupported: [],
    finalRepositoryVerified: false,
    limitations: [],
  }
}

function migrationFailure(
  legacyPath: string,
  resolved: MigrateCommandConfiguration,
  dryRun: boolean,
  error: unknown,
): LegacyMigrationReport {
  const known = error instanceof LegacyMigrationError
  const category = known ? error.category : 'internal'
  const now = new Date().toISOString()
  return {
    operation: 'legacy-migrate',
    startedAt: now,
    endedAt: now,
    dryRun,
    state: 'failure',
    category,
    counts: {
      filesConsidered: 0,
      filesWritten: 0,
      filesSkipped: 0,
      filesFailed: 0,
      bytesRead: 0,
      bytesWritten: 0,
    },
    verificationScope: 'structural',
    source: {
      repositoryPath: legacyPath,
      repositoryDigest: 'unknown',
      readOnly: true,
      deleted: false,
    },
    target: {
      repositoryPath: resolved.repositoryPath,
      repositoryId: resolved.repositoryId,
      protection: resolved.protection,
      requiredBytes: '0',
      availableBytes: null,
      authenticated: false,
      capabilityChecked: false,
      lockChecked: false,
    },
    points: [],
    results: [
      {
        legacyPointId: 'preflight',
        targetPointId: 'none',
        state: 'failure',
        contentVerified: false,
        issues: [
          {
            code: known ? error.code : 'MIGRATION_SERVICE_FAILED',
            category,
            message: known ? error.message : 'Migration service did not complete safely',
          },
        ],
      },
    ],
    unsupported: [],
    finalRepositoryVerified: false,
    limitations: [],
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/** Defined for T8 root wiring; this module does not register itself globally. */
export function registerMigrateCommand(
  program: Command,
  overrides: Partial<MigrateCommandDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  program
    .command('migrate')
    .description('Plan or execute a read-only copy migration from a 0.1.x repository')
    .requiredOption('--from <path>', 'Legacy 0.1.x RestoreBackup directory')
    .option('--point <id>', 'Migrate one legacy recovery point; may be repeated', collect, [])
    .option('--execute', 'Execute the copy plan; default is a no-write dry-run')
    .action(async (values: { from: string; point: string[]; execute?: boolean }) => {
      let result: LegacyMigrationReport
      let resolved: MigrateCommandConfiguration
      try {
        resolved = dependencies.resolve()
      } catch {
        result = configurationFailure(values.from)
        dependencies.writeStderr('migrate: MIGRATION_CONFIGURATION_INVALID')
        dependencies.writeStdout(JSON.stringify(result))
        dependencies.setExitCode(EXIT_CODES.configuration)
        return
      }
      try {
        result = await dependencies.migrate({
          legacyRepositoryPath: values.from,
          repositoryPath: resolved.repositoryPath,
          expectedRepositoryId: resolved.repositoryId,
          expectedProtection: resolved.protection,
          ...(resolved.protection === 'encrypted'
            ? { credentialProvider: dependencies.credentialProvider() }
            : {}),
          ...(values.point.length > 0 ? { pointIds: values.point } : {}),
          dryRun: !values.execute,
        })
      } catch (error) {
        result = migrationFailure(values.from, resolved, !values.execute, error)
      }
      if (result.category !== 'success') {
        const code =
          result.results.find((entry) => entry.issues.length > 0)?.issues[0]?.code ??
          'MIGRATION_FAILED'
        dependencies.writeStderr(`migrate: ${code}`)
      }
      dependencies.writeStdout(JSON.stringify(result))
      dependencies.setExitCode(EXIT_CODES[result.category])
    })
}
