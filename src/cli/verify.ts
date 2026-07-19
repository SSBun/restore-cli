import type { Command } from 'commander'
import { loadConfigStrict } from '../config/loader.js'
import { MacOsKeychainCredentialProvider } from '../protection/index.js'
import type { CredentialProvider } from '../protection/index.js'
import type { OperationCategory } from '../repository/index.js'
import { getBackupRoot } from '../util/path.js'
import { emitCliResult } from '../util/result.js'
import { verifyV1Repository } from '../verify/index.js'
import type { VerificationReport, VerificationSelector } from '../verify/index.js'

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

export interface VerifyCommandDependencies {
  resolve(): {
    repositoryPath: string
    repositoryId: string
    protection: 'encrypted' | 'plaintext'
  }
  verify: typeof verifyV1Repository
  credentialProvider(): CredentialProvider
  writeStdout(value: string): void
  writeStderr(value: string): void
  setExitCode(value: number): void
}

const DEFAULT_DEPENDENCIES: VerifyCommandDependencies = {
  resolve() {
    const config = loadConfigStrict()
    if (!config.repository) throw new Error('missing repository configuration')
    return {
      repositoryPath: getBackupRoot(config.destination.path),
      repositoryId: config.repository.id,
      protection: config.repository.protection,
    }
  },
  verify: verifyV1Repository,
  credentialProvider: () => new MacOsKeychainCredentialProvider(),
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
  setExitCode: (value) => {
    process.exitCode = value
  },
}

function configurationFailure(startedAt: string): VerificationReport {
  const endedAt = new Date().toISOString()
  const coverage = {
    pointsConsidered: 0,
    pointsVerified: 0,
    pointsSkipped: 0,
    pointsFailed: 0,
    filesConsidered: 0,
    filesVerified: 0,
    filesSkipped: 0,
    filesFailed: 0,
    bytesConsidered: 0,
    bytesVerified: 0,
    bytesSkipped: 0,
    bytesFailed: 0,
    complete: false,
  }
  return {
    operation: 'verify',
    scope: 'structural',
    verificationScope: 'structural',
    selector: { kind: 'latest-healthy' },
    resolvedPointIds: [],
    resolvedPointId: null,
    repositoryId: 'unknown',
    protection: 'encrypted',
    startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    cost: 'low',
    state: 'failure',
    category: 'configuration',
    ...coverage,
    coverage,
    points: [],
    issues: [
      {
        code: 'VERIFY_CONFIGURATION_INVALID',
        category: 'configuration',
        message: 'Verify configuration or selector is invalid',
        nextAction: 'Initialize or reconnect the expected repository',
      },
    ],
    nextAction: 'Initialize or reconnect the expected repository',
  }
}

export function registerVerifyCommand(
  program: Command,
  overrides: Partial<VerifyCommandDependencies> = {},
): void {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  program
    .command('verify')
    .description('Verify v1 recovery point structure or protected content')
    .option('--point <id>', 'Verify one immutable recovery point ID')
    .option('--latest', 'Verify the latest published recovery point')
    .option('--latest-healthy', 'Verify the latest strictly healthy recovery point')
    .option('--all', 'Verify every published recovery point')
    .option('--content', 'Read and authenticate every selected protected blob')
    .option('--structural', 'Verify metadata, references, and object identity')
    .action(
      async (values: {
        point?: string
        latest?: boolean
        latestHealthy?: boolean
        all?: boolean
        content?: boolean
        structural?: boolean
      }) => {
        const startedAt = new Date().toISOString()
        try {
          const selectors = [values.point, values.latest, values.latestHealthy, values.all].filter(
            Boolean,
          )
          if (selectors.length > 1 || (values.content && values.structural))
            throw new Error('conflicting options')
          let selector: VerificationSelector = { kind: 'latest-healthy' }
          if (values.point) selector = { kind: 'point', pointId: values.point }
          else if (values.latest) selector = { kind: 'latest' }
          else if (values.all) selector = { kind: 'all' }
          const resolved = dependencies.resolve()
          const result = await dependencies.verify({
            repositoryPath: resolved.repositoryPath,
            expectedRepositoryId: resolved.repositoryId,
            expectedProtection: resolved.protection,
            ...(resolved.protection === 'encrypted'
              ? { credentialProvider: dependencies.credentialProvider() }
              : {}),
            selector,
            scope: values.content ? 'content' : 'structural',
          })
          if (result.issues.length > 0)
            dependencies.writeStderr(`verify: ${result.issues[0]?.code}`)
          emitCliResult(program, dependencies.writeStdout, result)
          dependencies.setExitCode(EXIT_CODES[result.category])
        } catch {
          const result = configurationFailure(startedAt)
          dependencies.writeStderr('verify: VERIFY_CONFIGURATION_INVALID')
          emitCliResult(program, dependencies.writeStdout, result)
          dependencies.setExitCode(EXIT_CODES.configuration)
        }
      },
    )
}
